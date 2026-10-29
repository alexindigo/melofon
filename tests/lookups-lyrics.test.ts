import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import type { LyricsEntry } from '../src/lyrics.ts';
import { LookupHost, parseResult } from '../src/lookups/host.ts';
import { discoverLookups, parseManifest } from '../src/lookups/manifest.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { lookupManifest, lookupPlugin } from './helpers/lookup.ts';

const manifest = () =>
  lookupManifest({
    capabilities: [{
      id: 'lyrics',
      accepts: 'track',
      provides: ['track.lyrics'],
    }],
  });
const capability = () => parseManifest(manifest(), 'fixture').capabilities[0];
const plain = (): LyricsEntry => ({
  language: 'eng',
  synced: false,
  artist: 'Artist',
  title: 'Song',
  lines: [{ text: 'First line' }, { text: '' }, { text: 'Last line' }],
});
const enhanced = (): LyricsEntry => ({
  language: 'rus',
  synced: true,
  offset: -150,
  lines: [
    {
      start: 1000,
      text: 'Я 🎵!',
      cues: [
        { start: 1000, end: 1200, text: 'Я ', byteStart: 0, byteEnd: 2 },
        { start: 1200, text: '🎵', byteStart: 3, byteEnd: 6 },
      ],
    },
    { start: 1000, text: '' },
    { start: 2000, text: 'Again' },
  ],
});
const candidate = (entries: unknown = [plain(), enhanced()]) => ({
  target: { type: 'track', id: 'song-id' },
  confidence: 'strong',
  values: { 'track.lyrics': { url: 'https://fixture.test/lyrics/1', entries } },
  ids: { provider: '1' },
  evidence: { matchedTitle: 'Song' },
});
const outcome = (entries?: unknown) => ({ candidates: [candidate(entries)] });
const parse = (raw: unknown, maxBytes = 65536) =>
  parseResult(raw, capability(), { targetId: 'song-id', maxBytes });
const sparse = <T>(value: T): T[] => {
  const values = [value];
  values.length = 2;
  return values;
};

Deno.test('lyrics result preserves a whole candidate with source, confidence, variants and exact cues', () => {
  const raw = outcome([plain(), enhanced(), {
    ...plain(),
    language: 'eng',
    offset: 25,
  }]);
  const parsed = parse(raw);
  assertEquals<unknown>(parsed, raw);
  assert('candidates' in parsed);
  // The parsed boundary owns its plain-data snapshot, independent of the sender.
  raw.candidates[0].evidence.matchedTitle = 'changed';
  assertEquals(parsed.candidates[0].evidence, { matchedTitle: 'Song' });
  const frozen = outcome();
  Object.freeze(frozen.candidates[0].values);
  assertEquals<unknown>(parse(frozen), frozen);
  for (const confidence of ['medium', 'low']) {
    const raw = { candidates: [{ ...candidate(), confidence }] };
    assertEquals<unknown>(parse(raw), raw);
  }
});

Deno.test('lyrics outcomes reject foreign targets, undeclared values and malformed candidate metadata', () => {
  assertEquals(parse({ candidates: [] }), { candidates: [] });
  assertEquals(parse({ retryAfter: 2, reason: 'busy' }), {
    retryAfter: 2,
    reason: 'busy',
  });
  const proposal = candidate();
  for (
    const invalid of [
      { ...proposal, target: { type: 'track', id: 'different-song' } },
      { ...proposal, target: { type: 'song', id: 'song-id' } },
      { ...proposal, target: { type: 'album', id: 'song-id' } },
      { ...proposal, target: { type: 'artist', id: 'song-id' } },
      { ...proposal, target: { type: 'track', id: '' } },
      { ...proposal, values: {} },
      { ...proposal, values: { 'track.similar': [] } },
      {
        ...proposal,
        values: {
          ...proposal.values,
          'album.image.front': { url: 'https://fixture.test/' },
        },
      },
      { ...proposal, confidence: 'certain' },
      { ...proposal, confidence: ['strong'] },
      { ...proposal, source: 'forged-plugin' },
      { ...proposal, ids: { provider: 1 } },
      { ...proposal, evidence: [] },
    ]
  ) assertThrows(() => parse({ candidates: [invalid] }));
  for (
    const raw of [
      { candidates: sparse(proposal) },
      { values: { 'track.lyrics': proposal.values['track.lyrics'] } },
      { candidates: [], retryAfter: 1, reason: 'busy' },
      { candidates: [], reason: 'not retrying' },
      { retryAfter: Infinity, reason: 'busy' },
      { retryAfter: -1, reason: 'busy' },
      {
        candidates: [proposal, {
          ...proposal,
          target: { type: 'track', id: 'foreign' },
        }],
      },
    ]
  ) assertThrows(() => parse(raw));
});

Deno.test('lyrics entries require typed nonempty text sets and HTTP source provenance', () => {
  for (
    const entry of [
      {},
      { ...plain(), language: '' },
      { ...plain(), language: 1 },
      { ...plain(), synced: 'false' },
      { ...plain(), lines: [] },
      { ...plain(), lines: sparse({ text: 'hello' }) },
      { ...plain(), lines: [{ text: '  ' }] },
      { ...plain(), lines: [{ text: 42 }] },
      { ...plain(), lines: [{ text: 'bad\0text' }] },
      { ...plain(), lines: [{ text: '\ud800' }] },
      { ...plain(), title: 42 },
      { ...plain(), artist: null },
      { ...plain(), extra: true },
      { ...plain(), lines: [{ text: 'hello', extra: 1 }] },
    ]
  ) assertThrows(() => parse(outcome([entry])));
  assertThrows(() => parse(outcome([])));
  assertThrows(() => parse(outcome(sparse(plain()))));
  const proposal = candidate();
  const value = proposal.values['track.lyrics'];
  for (
    const invalid of [
      { entries: [plain()] },
      { ...value, url: 'file:///lyrics.txt' },
      { ...value, url: 'javascript:alert(1)' },
      { ...value, url: 'relative' },
      { ...value, entries: null },
      { ...value, source: 'forged-plugin' },
    ]
  ) {
    assertThrows(() =>
      parse({
        candidates: [{ ...proposal, values: { 'track.lyrics': invalid } }],
      })
    );
  }
});

Deno.test('lyrics timing uses ordered nonnegative integer milliseconds and signed integer offsets', () => {
  for (
    const start of [
      -1,
      1.5,
      Infinity,
      NaN,
      '1000',
      null,
      undefined,
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    assertThrows(() =>
      parse(outcome([{ ...enhanced(), lines: [{ start, text: 'hello' }] }]))
    );
  }
  for (
    const offset of [1.5, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]
  ) {
    assertThrows(() => parse(outcome([{ ...plain(), offset }])));
  }
  for (
    const entry of [
      { ...plain(), lines: [{ start: 0, text: 'hello' }] },
      { ...plain(), lines: [{ text: 'hello', cues: [] }] },
      {
        ...enhanced(),
        lines: [{ start: 2, text: 'a' }, { start: 1, text: 'b' }],
      },
      { ...enhanced(), lines: [{ start: 0, text: 'a' }, { text: 'b' }] },
    ]
  ) assertThrows(() => parse(outcome([entry])));
  const valid = outcome([{
    ...enhanced(),
    lines: [{ start: 0, text: 'zero' }, { start: 0, text: '' }],
  }]);
  assertEquals<unknown>(parse(valid), valid);
});

Deno.test('enhanced lyrics validate cue timing and inclusive UTF-8 spans against the line text', () => {
  const line = enhanced().lines[0];
  const cue = line.cues![0];
  for (
    const invalid of [
      { ...cue, start: 999 },
      { ...cue, start: -1 },
      { ...cue, start: 1000.5 },
      { ...cue, end: 999 },
      { ...cue, end: Infinity },
      { ...cue, byteStart: -1 },
      { ...cue, byteStart: 0.5 },
      { ...cue, byteEnd: 99 },
      { ...cue, byteStart: 3, byteEnd: 2 },
      { ...cue, byteEnd: 0 }, // split Cyrillic character
      { ...cue, byteStart: 4, byteEnd: 6, text: '🎵' }, // split emoji
      { ...cue, text: 'different' },
      { ...cue, text: '' },
      { ...cue, extra: 1 },
    ]
  ) {
    assertThrows(() =>
      parse(outcome([{ ...enhanced(), lines: [{ ...line, cues: [invalid] }] }]))
    );
  }
  for (
    const cues of [
      [],
      sparse(cue),
      [cue, cue], // overlapping spans
      [{ ...cue, start: 1300 }, line.cues![1]], // descending time
      [{ ...cue, byteEnd: 3 }, line.cues![1]], // span/text mismatch
    ]
  ) {
    assertThrows(() =>
      parse(outcome([{ ...enhanced(), lines: [{ ...line, cues }] }]))
    );
  }
});

Deno.test('lyrics result byte budget covers UTF-8, all candidates, variants and evidence', () => {
  const raw = outcome();
  const size = new TextEncoder().encode(JSON.stringify(raw)).length;
  assertEquals<unknown>(parse(raw, size), raw);
  assertThrows(() => parse(raw, size - 1), Error, 'byte budget');
  assertThrows(
    () => parse({ candidates: [candidate(), candidate()] }, size),
    Error,
    'byte budget',
  );
  assertThrows(
    () => parse(outcome([plain(), enhanced(), plain()]), size),
    Error,
    'byte budget',
  );
  assertThrows(
    () =>
      parse({
        candidates: [{ ...candidate(), evidence: { huge: 'x'.repeat(size) } }],
      }, size),
    Error,
    'byte budget',
  );
  for (const maxBytes of [0, -1, 1.5, Infinity]) {
    assertThrows(() => parse(raw, maxBytes));
  }
  assertThrows(() => parseResult(raw, capability()));
  assertThrows(() =>
    parseResult(raw, capability(), { targetId: '', maxBytes: size })
  );
});

async function withLyricsHost(fn: (host: LookupHost) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  let host: LookupHost | undefined;
  try {
    await lookupPlugin(
      `${dir}/lookups`,
      `export default { lyrics(item) { return item.result; } };`,
      'fixture',
      manifest(),
    );
    const plugin = (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0];
    host = new LookupHost(plugin, createLookupNetwork(), {
      heartbeatMs: 20,
      livenessMs: 1000,
    });
    await fn(host);
  } finally {
    await host?.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('lyrics candidates cross the existing discovered isolated-worker transport intact', async () => {
  await withLyricsHost(async (host) => {
    const raw = outcome();
    const result = await host.call(host.plugin.manifest!.capabilities[0], {
      contract: 1,
      type: 'track',
      id: 'song-id',
      result: raw,
    }, { timeoutMs: 5000, maxBytes: 65536 });
    assertEquals<unknown>(result, raw);
    assertEquals(host.state, 'ready');
    assertEquals(host.authority.hosts, []);
  });
});

Deno.test('worker lyric results cannot escape the called song or the supplied byte/timing contract', async () => {
  await withLyricsHost(async (host) => {
    const call = (raw: unknown, maxBytes = 65536) =>
      host.call(
        host.plugin.manifest!.capabilities[0],
        { type: 'track', id: 'song-id', result: raw },
        { timeoutMs: 5000, maxBytes },
      );
    await assertRejects(
      () =>
        call({
          candidates: [{
            ...candidate(),
            target: { type: 'track', id: 'foreign' },
          }],
        }),
      Error,
      'target',
    );
    await assertRejects(
      () =>
        call(outcome([{ ...enhanced(), lines: [{ start: -1, text: 'bad' }] }])),
      Error,
      'timing',
    );
    await assertRejects(() => call(outcome(), 10), Error, 'byte budget');
    await assertRejects(() => call({ candidates: sparse(candidate()) }));
    await assertRejects(() => call(outcome(sparse(plain()))));
    // A bad proposal fails its call, not the isolate or the following outcome.
    assertEquals(await call({ candidates: [] }), { candidates: [] });
    assertEquals(await call({ retryAfter: 1, reason: 'busy' }), {
      retryAfter: 1,
      reason: 'busy',
    });
    await assertRejects(
      () =>
        host.call(
          host.plugin.manifest!.capabilities[0],
          { result: outcome() },
          { timeoutMs: 5000, maxBytes: 65536 },
        ),
      Error,
      'target',
    );
  });
});
