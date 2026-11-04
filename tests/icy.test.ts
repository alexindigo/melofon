import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  ICY_MAX_METADATA_BYTES,
  IcyFramingError,
  icyInterval,
  type IcyMetadata,
  separateIcy,
} from '../src/icy.ts';
import { createNetwork } from '../src/lookups/net.ts';
import {
  httpRadio,
  icyBlock,
  radioRequestHeaders,
} from './helpers/http-radio.ts';

const encoder = new TextEncoder();
const headers = (interval: string | number) =>
  new Headers({ 'icy-metaint': String(interval) });
const authority = () => ({
  caller: 'core.icy-test',
  hosts: () => true,
  trustedHosts: ['melofon.home'],
  ratePerMinute: 600000,
  signal: new AbortController().signal,
});
const limits = { openTimeoutMs: 2000, idleTimeoutMs: 2000 };
function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function bytes(parts: Uint8Array[], onCancel?: (reason: unknown) => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === parts.length) controller.close();
      else controller.enqueue(parts[index++]);
    },
    cancel: onCancel,
  }, { highWaterMark: 0 });
}
async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return join(parts);
}
function* fragments(data: Uint8Array, size: number) {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, offset + size);
  }
}
function framed(
  audio: Uint8Array,
  interval: number,
  blocks: Uint8Array[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  let index = 0;
  for (let offset = 0; offset < audio.length; offset += interval) {
    const part = audio.subarray(offset, offset + interval);
    parts.push(part);
    if (part.length === interval) parts.push(blocks[index++] ?? icyBlock(''));
  }
  return join(parts);
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function eventually(check: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    assert(performance.now() < deadline, 'HTTP peer did not close');
    await sleep(10);
  }
}
const untilAborted = (signal: AbortSignal) =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((done) =>
      signal.addEventListener('abort', () => done(), { once: true })
    );

Deno.test('ICY real HTTP requires metadata negotiation and delivers byte-exact MP3 with distinct title updates', async () => {
  const audio = await Deno.readFile(
    new URL(
      './fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
      import.meta.url,
    ),
  );
  const blocks = [
    icyBlock("StreamTitle='First';"),
    icyBlock(''),
    icyBlock(
      "StreamTitle='Second; artist's song';StreamUrl='https://image.test/cover.jpg';",
    ),
    icyBlock("StreamTitle='';"),
    icyBlock("Unknown='ignored';"),
  ];
  const wire = framed(audio, 257, blocks);
  const fixture = httpRadio((request) => {
    assertEquals(request.headers.get('accept-encoding'), 'identity');
    return {
      headers: { 'icy-metaint': '257', 'icy-name': 'Stable station' },
      body: fragments(wire, 7),
    };
  });
  const network = createNetwork();
  try {
    const refused = await network.stream(
      authority(),
      fixture.origin,
      {},
      limits,
    );
    try {
      assertEquals(refused.response.status, 400);
      await refused.response.body?.cancel();
    } finally {
      await refused.close();
    }
    const lease = await network.stream(authority(), fixture.origin, {
      headers: radioRequestHeaders,
    }, limits);
    try {
      assertEquals(lease.response.headers.get('icy-name'), 'Stable station');
      const facts: IcyMetadata[] = [];
      const stripped = separateIcy(
        lease.response.body!,
        lease.response.headers,
        (value) => facts.push(value),
      );
      assertEquals(await collect(stripped), audio);
      assertEquals(facts, [
        { streamTitle: 'First' },
        {
          streamTitle: "Second; artist's song",
          streamUrl: 'https://image.test/cover.jpg',
        },
        { streamTitle: '' },
      ]);
      assertEquals(fixture.requests.length, 2);
    } finally {
      await lease.close();
    }
  } finally {
    await fixture.close();
  }
});

Deno.test('ICY framing is independent of every input split, including length, UTF-8 and padding boundaries', async () => {
  const audio = new Uint8Array([0, 1, 255, 2, 3, 4, 5, 6, 7]);
  const wire = framed(audio, 3, [
    icyBlock(
      "StreamTitle='\u041f\u0435\u0441\u043d\u044f';StreamUrl='https://example.test/a;b';",
    ),
    icyBlock(''),
    icyBlock("StreamTitle='';"),
  ]);
  for (let split = 0; split <= wire.length; split++) {
    const facts: IcyMetadata[] = [];
    assertEquals(
      await collect(
        separateIcy(
          bytes([wire.subarray(0, split), wire.subarray(split)]),
          headers(3),
          (value) => facts.push(value),
        ),
      ),
      audio,
    );
    assertEquals(facts, [{
      streamTitle: '\u041f\u0435\u0441\u043d\u044f',
      streamUrl: 'https://example.test/a;b',
    }, { streamTitle: '' }]);
  }
  const facts: IcyMetadata[] = [];
  assertEquals(
    await collect(
      separateIcy(
        bytes([...fragments(wire, 1)]),
        headers(3),
        (value) => facts.push(value),
      ),
    ),
    audio,
  );
  assertEquals(facts.length, 2);
});

Deno.test('ICY validates positive integer framing without allocating by interval', async () => {
  assertEquals(icyInterval(new Headers()), null);
  for (
    const value of [
      '',
      '0',
      '-1',
      '+1',
      '1.5',
      '1e3',
      'NaN',
      'Infinity',
      '9007199254740992',
      '1, 2',
      '2x',
    ]
  ) {
    const body = bytes([new Uint8Array([1])]);
    assertThrows(
      () => separateIcy(body, headers(value), () => {}),
      IcyFramingError,
      'Invalid icy-metaint',
    );
    assertEquals(
      body.locked,
      false,
      'invalid headers must not acquire the body',
    );
  }
  assertEquals(icyInterval(headers('00016')), 16);
  assertEquals(
    await collect(
      separateIcy(
        bytes([new Uint8Array([1, 2])]),
        headers(9007199254740991),
        () => {},
      ),
    ),
    new Uint8Array([1, 2]),
  );
});

Deno.test('ICY absent header preserves ordinary HTTP media including metadata-like bytes', async () => {
  const audio = join([
    new Uint8Array([0, 255, 1]),
    icyBlock("StreamTitle='not a fact';"),
  ]);
  const fixture = httpRadio(() => ({ body: fragments(audio, 1) }));
  try {
    const lease = await createNetwork().stream(authority(), fixture.origin, {
      headers: radioRequestHeaders,
    }, limits);
    try {
      const body = lease.response.body!;
      const output = separateIcy(body, lease.response.headers, () => {
        throw new Error('unexpected metadata');
      });
      assertEquals(output, body);
      assertEquals(await collect(output), audio);
    } finally {
      await lease.close();
    }
  } finally {
    await fixture.close();
  }
});

Deno.test('ICY retains raw title, safely skips unknown fields and uses UTF-8 then ISO-8859-1', async () => {
  const latin = join([
    encoder.encode("StreamTitle='caf"),
    new Uint8Array([0xe9]),
    encoder.encode("';StreamUrl='';"),
  ]);
  const blocks = [
    icyBlock(
      "Unknown='fake;StreamTitle=not-a-field';streamtitle='  Artist - Title  ';",
    ),
    icyBlock(latin),
    icyBlock("StreamTitle=malformed;Unknown='ignored';"),
    icyBlock("StreamTitle='before padding';\0StreamTitle='not after NUL';"),
  ];
  const facts: IcyMetadata[] = [];
  const audio = new Uint8Array([1, 2, 3, 4]);
  assertEquals(
    await collect(
      separateIcy(
        bytes([framed(audio, 1, blocks)]),
        headers(1),
        (value) => facts.push(value),
      ),
    ),
    audio,
  );
  assertEquals(facts, [{ streamTitle: '  Artist - Title  ' }, {
    streamTitle: 'caf\u00e9',
    streamUrl: '',
  }, { streamTitle: 'before padding' }]);
});

Deno.test('ICY maximum 4080-byte metadata blocks are consumed incrementally without reading ahead', async () => {
  const title = 'x'.repeat(ICY_MAX_METADATA_BYTES - "StreamTitle='';".length);
  const block = icyBlock(`StreamTitle='${title}';`);
  assertEquals(block.length, 4081);
  assertEquals(block[0], 255);
  const frame = join([new Uint8Array([42]), block]);
  let pulls = 0;
  let events = 0;
  const input = new ReadableStream<Uint8Array>({
    pull(controller) {
      const index = pulls++;
      if (index === frame.length + 1) controller.close();
      else {
        controller.enqueue(
          new Uint8Array([index === frame.length ? 43 : frame[index]]),
        );
      }
    },
  }, { highWaterMark: 0 });
  const reader = separateIcy(input, headers(1), (value) => {
    assertEquals(value.streamTitle, title);
    events++;
  }).getReader();
  assertEquals(pulls, 0);
  assertEquals((await reader.read()).value, new Uint8Array([42]));
  assertEquals(pulls, 1);
  assertEquals(events, 0);
  assertEquals((await reader.read()).value, new Uint8Array([43]));
  assertEquals(events, 1);
  assertEquals(pulls, frame.length + 1);
  await reader.cancel();
  reader.releaseLock();
  assertEquals(input.locked, false);
});

Deno.test('ICY a large coalesced input does not eagerly parse or accumulate metadata events', async () => {
  const frame = join([new Uint8Array([7]), icyBlock("StreamTitle='same';")]);
  const wire = join(Array.from({ length: 10000 }, () => frame));
  let events = 0;
  const input = bytes([wire]);
  const reader = separateIcy(input, headers(1), () => {
    events++;
  }).getReader();
  for (let index = 0; index < 10000; index++) {
    assertEquals((await reader.read()).value, new Uint8Array([7]));
    assertEquals(events, index, 'metadata is driven by downstream demand');
  }
  assertEquals((await reader.read()).done, true);
  assertEquals(events, 10000);
  reader.releaseLock();
  assertEquals(input.locked, false);
});

Deno.test('ICY real HTTP missing length and truncated metadata report a drop, never metadata as audio', async () => {
  const audio = new Uint8Array([10, 20, 30]);
  const block = icyBlock("StreamTitle='incomplete';");
  const fixture = httpRadio((request) => ({
    headers: { 'icy-metaint': '3' },
    body: [
      audio,
      ...(new URL(request.url).pathname === '/length'
        ? []
        : [block.subarray(0, block.length - 1)]),
    ],
  }));
  try {
    for (const path of ['/length', '/payload']) {
      const lease = await createNetwork().stream(
        authority(),
        fixture.origin + path,
        { headers: radioRequestHeaders },
        limits,
      );
      try {
        let count = 0;
        const reader = separateIcy(
          lease.response.body!,
          lease.response.headers,
          () => {
            count++;
          },
        ).getReader();
        assertEquals((await reader.read()).value, audio);
        await assertRejects(
          () => reader.read(),
          IcyFramingError,
          'Truncated ICY',
        );
        reader.releaseLock();
        assertEquals(count, 0);
      } finally {
        await lease.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

Deno.test('ICY preserves upstream errors and callback failures while cancelling its body reader', async () => {
  const failure = new Error('upstream transport failed');
  const failed = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });
  assertEquals(
    await assertRejects(() =>
      collect(separateIcy(failed, headers(3), () => {}))
    ),
    failure,
  );
  assertEquals(failed.locked, false);
  let cancelled: unknown;
  const callbackFailure = new Error('metadata consumer failed');
  const input = bytes([
    framed(new Uint8Array([1, 2]), 1, [icyBlock("StreamTitle='a';")]),
  ], (reason) => {
    cancelled = reason;
  });
  assertEquals(
    await assertRejects(() =>
      collect(separateIcy(input, headers(1), () => {
        throw callbackFailure;
      }))
    ),
    callbackFailure,
  );
  assertEquals(cancelled, callbackFailure);
  assertEquals(input.locked, false);
});

Deno.test('ICY cancellation releases unread and parked HTTP audio or metadata reads promptly', async () => {
  const fixture = httpRadio((request, signal) => ({
    headers: { 'icy-metaint': '1' },
    body: (async function* () {
      yield new Uint8Array([42]);
      if (new URL(request.url).pathname === '/metadata') {
        yield new Uint8Array([255, 1]);
      }
      await untilAborted(signal);
    })(),
  }));
  try {
    let closed = 0;
    for (const path of ['/unread', '/audio', '/metadata']) {
      const lease = await createNetwork().stream(
        authority(),
        fixture.origin + path,
        { headers: radioRequestHeaders },
        limits,
      );
      try {
        const reader = separateIcy(
          lease.response.body!,
          lease.response.headers,
          () => {
            throw new Error('incomplete metadata');
          },
        ).getReader();
        let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
        if (path !== '/unread') {
          assertEquals((await reader.read()).value, new Uint8Array([42]));
          pending = reader.read();
          await sleep(20);
        }
        await reader.cancel('next source');
        if (pending) assertEquals((await pending).done, true);
        reader.releaseLock();
        closed++;
        await eventually(() => fixture.closed === closed);
      } finally {
        await lease.close();
      }
    }
  } finally {
    await fixture.close();
  }
});

Deno.test('ICY upstream Content-Length truncation is not converted into clean audio EOF', async () => {
  const fixture = httpRadio(() => ({
    headers: { 'icy-metaint': '100', 'content-length': '99' },
    body: [new Uint8Array([1, 2])],
  }));
  try {
    const lease = await createNetwork().stream(authority(), fixture.origin, {
      headers: radioRequestHeaders,
    }, limits);
    try {
      await assertRejects(() =>
        collect(
          separateIcy(lease.response.body!, lease.response.headers, () => {}),
        )
      );
    } finally {
      await lease.close();
    }
  } finally {
    await fixture.close();
  }
});

Deno.test('ICY delivers live HTTP audio and metadata before EOF and preserves authority abort during framing', async () => {
  const fixture = httpRadio((_request, signal) => ({
    headers: { 'icy-metaint': '1' },
    body: (async function* () {
      yield new Uint8Array([10]);
      yield icyBlock("StreamTitle='Live';");
      yield new Uint8Array([20, 255, 1]);
      await untilAborted(signal);
    })(),
  }));
  const abort = new AbortController();
  try {
    const lease = await createNetwork().stream(
      { ...authority(), signal: abort.signal },
      fixture.origin,
      { headers: radioRequestHeaders },
      limits,
    );
    try {
      const facts: IcyMetadata[] = [];
      const reader = separateIcy(
        lease.response.body!,
        lease.response.headers,
        (value) => facts.push(value),
      ).getReader();
      assertEquals((await reader.read()).value, new Uint8Array([10]));
      assertEquals((await reader.read()).value, new Uint8Array([20]));
      assertEquals(facts, [{ streamTitle: 'Live' }]);
      assertEquals(fixture.closed, 0, 'audio and metadata arrive before EOF');
      const pending = reader.read();
      const reason = new Error('source generation revoked');
      abort.abort(reason);
      assertEquals(await assertRejects(() => pending), reason);
      reader.releaseLock();
      await eventually(() => fixture.closed === 1);
      assertEquals(
        facts,
        [{ streamTitle: 'Live' }],
        'partial old metadata is never published',
      );
    } finally {
      await lease.close();
    }
  } finally {
    await fixture.close();
  }
});

Deno.test('legacy ICY 200 OK status lines are rejected by the HTTP owner rather than accepted as radio', async () => {
  const fixture = httpRadio(() => ({
    statusLine: 'ICY 200 OK',
    headers: { 'icy-metaint': '1' },
    body: [new Uint8Array([42, 0])],
  }));
  try {
    await assertRejects(
      () =>
        createNetwork().stream(authority(), fixture.origin, {
          headers: radioRequestHeaders,
        }, limits),
      Error,
      'Parse Error',
    );
    assertEquals(fixture.requests.length, 1);
  } finally {
    await fixture.close();
  }
});
