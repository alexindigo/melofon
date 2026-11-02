import { assert, assertEquals, assertRejects } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { authFixture } from './helpers/authentication.ts';
import { rawSql } from '../src/store/testing.ts';
import { CapabilityError } from '../src/stream-capabilities.ts';
import { UserError } from '../src/user-errors.ts';

const path = '/api/v1/me/playback-capabilities';
const declaration = {
  name: ' Browser ',
  platform: ' Linux ',
  maxAudioBitrate: 320000,
  maxTranscodingAudioBitrate: 192000,
  directPlayProfiles: [{
    containers: [' MP3 ', 'mp3'],
    audioCodecs: ['MP3'],
    protocols: ['HTTP'],
    maxAudioChannels: 2,
  }],
  transcodingProfiles: [{
    container: 'MP3',
    audioCodec: 'MP3',
    protocol: 'HTTP',
    maxAudioChannels: 2,
  }],
  codecProfiles: [{
    type: 'AudioCodec',
    name: 'MP3',
    limitations: [{
      name: 'audioSamplerate',
      comparison: 'LessThanEqual',
      values: ['048000', '48000'],
      required: true,
    }, {
      name: 'audioProfile',
      comparison: 'NotEquals',
      values: ['HIGH'],
      required: false,
    }],
  }],
};
const normalized = {
  name: 'Browser',
  platform: 'Linux',
  maxAudioBitrate: 320000,
  maxTranscodingAudioBitrate: 192000,
  directPlayProfiles: [{
    containers: ['mp3'],
    audioCodecs: ['mp3'],
    protocols: ['http'],
    maxAudioChannels: 2,
  }],
  transcodingProfiles: [{
    container: 'mp3',
    audioCodec: 'mp3',
    protocol: 'http',
    maxAudioChannels: 2,
  }],
  codecProfiles: [{
    type: 'AudioCodec',
    name: 'mp3',
    limitations: [{
      name: 'audioSamplerate',
      comparison: 'LessThanEqual',
      values: ['48000'],
      required: true,
    }, {
      name: 'audioProfile',
      comparison: 'NotEquals',
      values: ['high'],
      required: false,
    }],
  }],
};
const empty = {
  name: 'Other',
  platform: 'App',
  directPlayProfiles: [],
  transcodingProfiles: [],
  codecProfiles: [],
};

async function read(
  f: Awaited<ReturnType<typeof apiFixture>>,
  credential: string,
) {
  const r = await f.get(path, credential);
  assertEquals(r.status, 200, await r.clone().text());
  return await r.json();
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'capability observer timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test('API stream capabilities: per-login normalized replace is private to the device', async () => {
  const f = await apiFixture();
  const sockets: WebSocket[] = [];
  try {
    const ips = await Deno.resolveDns('melofon.home', 'A');
    assert(ips.length > 0 && ips.every((ip) => !ip.startsWith('127.')));
    await f.auth.users.create(f.admin.id, {
      username: 'alice',
      password: 'password-alice',
      role: 'user',
    });
    const a = await f.login('cookie', 'alice', 'password-alice', 'Phone');
    const b = await f.login('bearer', 'alice', 'password-alice', 'Phone');
    const admin = await f.login('bearer');
    const frames: Record<string, unknown>[][] = [];
    for (const credential of [b.credential, admin.credential]) {
      const ws = new WebSocket(
        f.origin.replace('http:', 'ws:') + '/api/v1/events',
        {
          headers: { Origin: f.origin, Authorization: `Bearer ${credential}` },
        },
      );
      sockets.push(ws);
      const messages: Record<string, unknown>[] = [];
      frames.push(messages);
      ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
      await waitFor(() => messages.some((m) => m.type === 'hello'));
      messages.length = 0;
    }
    assertEquals(await read(f, a.credential), { capabilities: null });
    const r = await f.json(path, 'PUT', declaration, a.credential);
    assertEquals(r.status, 200, await r.clone().text());
    assertEquals(await r.json(), { capabilities: normalized });
    assertEquals(await read(f, a.credential), { capabilities: normalized });
    assertEquals(await read(f, b.credential), { capabilities: null });
    assertEquals(await read(f, admin.credential), { capabilities: null });
    const other = await f.json(
      '/_melofon' + path,
      'PUT',
      { name: 'Other', platform: 'App' },
      b.credential,
      null,
    );
    assertEquals(other.status, 200);
    assertEquals(await other.json(), { capabilities: empty });
    assertEquals(await read(f, b.credential), { capabilities: empty });
    assertEquals(await read(f, a.credential), { capabilities: normalized });
    const replacement = await f.json(path, 'PUT', {
      name: 'Other',
      platform: 'App',
    }, a.credential);
    assertEquals(replacement.status, 200);
    assertEquals(await replacement.json(), { capabilities: empty });
    assertEquals(await read(f, a.credential), { capabilities: empty });
    const sessions = await f.get('/api/v1/me/sessions', a.credential);
    const body = await sessions.json();
    assert(
      body.sessions.every((s: Record<string, unknown>) =>
        !('capabilities' in s) && !('playbackCapabilities' in s)
      ),
    );
    // A delivered all-audience marker drains queued invalidations. Declaration
    // changes themselves must not disclose data or private session ids.
    f.notify.emit(['library'], { library: ['capability-drain'] }, 'all');
    for (const messages of frames) {
      await waitFor(() =>
        JSON.stringify(messages).includes('capability-drain')
      );
      assertEquals(messages, [{
        type: 'changed',
        events: { library: ['capability-drain'] },
      }]);
    }
  } finally {
    for (const ws of sockets) {
      ws.close();
      await waitFor(() => ws.readyState === WebSocket.CLOSED);
    }
    await f.close();
  }
});

Deno.test('API stream capabilities: invalid, oversized and unauthenticated writes preserve the previous declaration', async () => {
  const f = await apiFixture();
  try {
    const a = await f.login();
    const bearer = await f.login('bearer');
    await (await f.json(path, 'PUT', declaration, a.credential)).body?.cancel();
    const invalid: unknown[] = [
      {},
      { ...declaration, userId: f.admin.id },
      { ...declaration, sessionId: a.body.session.id },
      { ...declaration, name: '' },
      { ...declaration, platform: false },
      ...[-1, 0, 1.5, '320000', Number.MAX_SAFE_INTEGER + 1].map((
        maxAudioBitrate,
      ) => ({ ...declaration, maxAudioBitrate })),
      { ...declaration, directPlayProfiles: null },
      {
        ...declaration,
        directPlayProfiles: [{
          containers: ['mp3'],
          audioCodecs: [3],
          protocols: ['http'],
        }],
      },
      {
        ...declaration,
        directPlayProfiles: [{
          containers: [],
          audioCodecs: [],
          protocols: ['ftp'],
        }],
      },
      {
        ...declaration,
        transcodingProfiles: [{
          container: 'mp3',
          audioCodec: 'mp3',
          protocol: 'http',
          maxAudioChannels: 0,
        }],
      },
      { ...declaration, codecProfiles: [{ type: 'VideoCodec', name: 'h264' }] },
      ...[
        {
          name: 'nonsense',
          comparison: 'Equals',
          values: ['2'],
          required: true,
        },
        {
          name: ['audioChannels'],
          comparison: 'Equals',
          values: ['2'],
          required: true,
        },
        {
          name: 'audioChannels',
          comparison: 'Unknown',
          values: ['2'],
          required: true,
        },
        {
          name: 'audioChannels',
          comparison: 'Equals',
          values: [],
          required: true,
        },
        {
          name: 'audioChannels',
          comparison: 'Equals',
          values: ['NaN'],
          required: true,
        },
        {
          name: 'audioSamplerate',
          comparison: 'Equals',
          values: ['48000'],
          required: 'true',
        },
      ].map((lim) => ({
        ...declaration,
        codecProfiles: [{
          type: 'AudioCodec',
          name: 'mp3',
          limitations: [lim],
        }],
      })),
    ];
    for (const input of invalid) {
      await error(
        await f.json(path, 'PUT', input, a.credential),
        400,
        'invalid_value',
      );
      assertEquals(await read(f, a.credential), { capabilities: normalized });
    }
    await error(
      await f.json(
        path,
        'PUT',
        { ...declaration, name: 'x'.repeat(65536) },
        a.credential,
      ),
      413,
      'too_large',
    );
    await f.state.set('stream.capabilitiesMaxBytes', '100');
    await error(
      await f.json(path, 'PUT', declaration, a.credential),
      413,
      'too_large',
    );
    await f.state.set('stream.capabilitiesMaxBytes', '65536');
    await error(
      await f.json(path, 'PUT', declaration, a.credential, null),
      403,
      'origin',
    );
    await error(
      await f.json(path, 'PUT', declaration, a.credential, 'http://other.home'),
      403,
      'origin',
    );
    await error(
      await f.request(path, {
        method: 'PUT',
        headers: {
          Cookie: a.credential,
          Origin: f.origin,
          'Content-Type': 'application/json',
        },
        body: '{',
      }),
      400,
      'not_json',
    );
    await error(await f.get(path), 401, 'unauthenticated');
    await error(
      await f.json('/_melofon' + path, 'PUT', declaration),
      401,
      'unauthenticated',
    );
    const spoof = await f.get(path, a.credential, {
      Authorization: 'Bearer invalid',
    });
    await error(spoof, 401, 'unauthenticated');
    assertEquals(await read(f, a.credential), { capabilities: normalized });
    const r = await f.json(path, 'PUT', declaration, bearer.credential, null);
    assertEquals(r.status, 200);
    await r.body?.cancel();
  } finally {
    await f.close();
  }
});

Deno.test('stream capabilities core: validates without the hat and enforces session ownership and lifecycle', async () => {
  const f = await authFixture();
  try {
    const member = await f.auth.users.create(f.admin.id, {
      username: 'alice',
      password: 'password-alice',
      role: 'user',
    });
    const a = await f.signIn('alice', 'password-alice');
    const b = await f.signIn('alice', 'password-alice');
    const sessions = f.auth.sessions;
    const write = (input: unknown) =>
      sessions.replacePlaybackCapabilities(member.id, a.session.id, input);
    assertEquals(await write(declaration), normalized);
    for (
      const input of [null, [], { ...declaration, maxAudioBitrate: Infinity }, {
        ...declaration,
        userId: member.id,
      }]
    ) {
      await assertRejects(() => write(input), CapabilityError);
    }
    await f.state.set('stream.capabilitiesMaxBytes', '100');
    await assertRejects(() => write(declaration), CapabilityError, 'too large');
    await assertRejects(
      () => write({ name: 'Other', platform: 'App' }),
      CapabilityError,
      'too large',
    );
    await f.state.set('stream.capabilitiesMaxBytes', '65536');
    assertEquals(
      await sessions.playbackCapabilities(member.id, a.session.id),
      normalized,
    );
    await assertRejects(
      () => sessions.playbackCapabilities(f.admin.id, a.session.id),
      UserError,
      'forbidden',
    );
    await assertRejects(
      () =>
        sessions.replacePlaybackCapabilities(
          f.admin.id,
          a.session.id,
          declaration,
        ),
      UserError,
      'forbidden',
    );
    await sessions.replacePlaybackCapabilities(
      member.id,
      b.session.id,
      declaration,
    );
    await sessions.revoke(member.id, a.session.id);
    await assertRejects(() => write(declaration), UserError, 'not_found');
    assertEquals(
      await sessions.playbackCapabilities(member.id, b.session.id),
      normalized,
    );
    await sessions.revokeAll(member.id);
    await assertRejects(
      () => sessions.playbackCapabilities(member.id, b.session.id),
      UserError,
      'not_found',
    );
    const c = await f.signIn('alice', 'password-alice');
    await sessions.replacePlaybackCapabilities(
      member.id,
      c.session.id,
      declaration,
    );
    await f.auth.users.setPassword(member.id, member.id, {
      current: 'password-alice',
      new: 'password-next',
    });
    await assertRejects(
      () => sessions.playbackCapabilities(member.id, c.session.id),
      UserError,
      'not_found',
    );
    const d = await f.signIn('alice', 'password-next');
    await sessions.replacePlaybackCapabilities(
      member.id,
      d.session.id,
      declaration,
    );
    await f.state.set('auth.sessionIdleDays', '1');
    f.advance(86400001);
    assertEquals(await sessions.authenticate(d.key), null);
    await assertRejects(
      () => sessions.playbackCapabilities(member.id, d.session.id),
      UserError,
      'not_found',
    );
    assertEquals(
      await rawSql(f.store).all('SELECT playback_capabilities FROM sessions'),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('API stream capabilities: old session schema migrates and HTTP declaration survives reopen then revoke', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'melofon-capabilities-upgrade-',
  });
  let f = await apiFixture({ storeDir: dir });
  try {
    const a = await f.login();
    const b = await f.login('bearer');
    const before = await f.auth.sessions.list(f.admin.id);
    await rawSql(f.store).run(
      'ALTER TABLE sessions DROP COLUMN playback_capabilities',
    );
    await f.close();
    f = await apiFixture({ storeDir: dir });
    assertEquals(await f.auth.sessions.list(f.admin.id), before);
    assertEquals(await read(f, a.credential), { capabilities: null });
    const r = await f.json(path, 'PUT', declaration, a.credential);
    assertEquals(r.status, 200);
    await r.body?.cancel();
    await f.close();
    f = await apiFixture({ storeDir: dir });
    assertEquals(await read(f, a.credential), { capabilities: normalized });
    assertEquals(await read(f, b.credential), { capabilities: null });
    const revoked = await f.json(
      `/api/v1/me/sessions/${a.body.session.id}`,
      'DELETE',
      undefined,
      b.credential,
    );
    assertEquals(revoked.status, 200);
    await revoked.body?.cancel();
    await error(await f.get(path, a.credential), 401, 'unauthenticated');
    await error(
      await f.json(path, 'PUT', declaration, a.credential),
      401,
      'unauthenticated',
    );
    assertEquals(
      await rawSql(f.store).all(
        'SELECT playback_capabilities FROM sessions WHERE playback_capabilities IS NOT NULL',
      ),
      [],
    );
    assertEquals(await read(f, b.credential), { capabilities: null });
  } finally {
    await f.close();
    await Deno.remove(dir, { recursive: true });
  }
});
