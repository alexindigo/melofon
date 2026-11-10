import { assert, assertEquals, assertRejects } from '@std/assert';
import { createOutputs } from '../src/player.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { PlaybackError } from '../src/playback-errors.ts';
import { receiver } from './helpers/speaker-consumer.ts';
import { sleep, until } from './helpers/speaker-consumer.ts';
import { openStore } from '../src/store/index.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlaybackReports } from '../src/playback-reports.ts';
import { createPlayers, type PlayerBoot } from '../src/players.ts';
import { createPersistence } from '../src/persistence.ts';
import { createNotify } from '../src/notify.ts';
import { createMedia } from '../src/media.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import type {
  HelperEventFn,
  PairingCredentialConsumer,
} from '../src/boots/airplay-profile.ts';
import { createSpeakerCredentials } from '../src/speaker-credentials.ts';
import { createSecrets } from '../src/secrets.ts';
import { restored } from './helpers/prepared.ts';
import { catalogMedia } from '../src/queue-source.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

const input = {
  volume: 50,
  positionMs: 0,
  lengthMs: 1000,
  title: '',
  artist: '',
};
function fixture() {
  const outputs = createOutputs();
  outputs.register({
    id: 's',
    name: 'Speaker',
    type: 'AirPlay',
    host: '127.0.0.1',
    port: 7000,
    selected: false,
    volume: 80,
  });
  outputs.setMembers(2, ['s']);
  const service = receiver(1, 7000);
  let lookup = () => Promise.resolve(service);
  let creates = 0;
  const devices = createAirplayDevices({
    outputs,
    resolver: { resolve: () => lookup(), close() {} },
    spawn: () => {
      creates++;
      return {
        transport: {
          send: () => Promise.resolve(),
          pcm: () => Promise.resolve(),
          close: () => Promise.resolve(),
          ownsSharedFeed: () => false,
          cancelPcm() {},
        },
        start: () => Promise.resolve(),
      };
    },
  });
  const speakers = createSpeakers({
    outputs,
    adapterView: devices.describe,
    prepare: devices.preparePlayback,
  });
  return {
    outputs,
    devices,
    speakers,
    setLookup: (next: typeof lookup) => lookup = next,
    creates: () => creates,
    prepare: () =>
      devices.protocol.prepare({
        id: 's',
        targetRevision: devices.admission.describe('s').targetRevision,
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
  };
}

Deno.test('second-player preflight uses membership through the shared AirPlay device', async () => {
  const f = fixture();
  try {
    await f.speakers.preparePlayback(new AbortController().signal, 2);
    assertEquals(f.devices.describe('s').preparation.state, 'ready');
    assertEquals(f.creates(), 0, 'preflight facts are not a playback grant');
    assertEquals(f.outputs.get('s')!.playerId, 2);
    assertEquals(f.outputs.get('s')!.selected, false);
  } finally {
    f.devices.close();
  }
});

Deno.test('outer preparation cannot accept an away-and-back completion', async () => {
  const f = fixture(), held = deferred<boolean>(), entered = deferred<void>();
  const speakers = createSpeakers({
    outputs: f.outputs,
    adapterView: f.devices.describe,
    prepare: () => {
      entered.resolve();
      return held.promise;
    },
  });
  try {
    const pending = speakers.preparePlayback(new AbortController().signal, 2);
    await entered.promise;
    const physical = f.outputs.revision('s');
    f.outputs.setMembers(1, ['s']);
    f.outputs.setMembers(2, ['s']);
    held.resolve(true);
    await assertRejects(() => pending, PlaybackError);
    assertEquals(
      f.outputs.revision('s'),
      physical,
      'a move is not a new receiver',
    );
  } finally {
    held.resolve(false);
    f.devices.close();
  }
});

Deno.test('shared device permits expire on membership transfer even away and back', async () => {
  const f = fixture();
  try {
    const permit = await f.prepare();
    assert(permit.ok);
    const facts = f.devices.protocol.facts('s');
    f.outputs.setMembers(1, ['s']);
    f.outputs.setMembers(2, ['s']);
    const result = await f.devices.protocol.activate(permit.value, input, {
      publish() {},
      onEvent() {},
    });
    if (result.ok) await result.value.close();
    assert(!result.ok, 'former membership cannot authorize a later start');
    assertEquals(f.creates(), 0);
    assertEquals(
      f.devices.protocol.facts('s'),
      facts,
      'physical facts survive a move',
    );
  } finally {
    f.devices.close();
  }
});

async function household() {
  const dir = await restored('membership-authority', async (dir) => {
    const store = await openStore(dir);
    try {
      await createLibraries(store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-authority-');
  const store = await openStore(dir), notify = createNotify();
  const persistence = createPersistence(store);
  const outputs = createOutputs({ notify, persistence });
  const credentials = createSpeakerCredentials({
    store: store.speakers,
    secrets: createSecrets(undefined),
    current: (id) =>
      outputs.get(id)
        ? {
          revision: outputs.revision(id),
          adopted: outputs.lifetime(id).adopted,
        }
        : null,
  });
  type Session = {
    event: HelperEventFn;
    credential?: PairingCredentialConsumer;
    bytes: number;
    closed: boolean;
    closing: boolean;
    closeGate?: Promise<void>;
  };
  const sessions: Session[] = [], timers: (() => void)[] = [];
  let lookup = () => Promise.resolve(receiver(1, 7000, { sf: '200' }));
  let challenge = false;
  const devices = createAirplayDevices({
    outputs,
    credentials,
    changed: () => notify.emit(['outputs'], undefined, 'all'),
    resolver: { resolve: () => lookup(), close() {} },
    spawn(event, credential) {
      const session: Session = {
        event,
        credential,
        bytes: 0,
        closed: false,
        closing: false,
      };
      sessions.push(session);
      return {
        transport: {
          send: () => Promise.resolve(),
          pcm(chunk) {
            session.bytes += chunk.length;
            return Promise.resolve();
          },
          async close() {
            session.closing = true;
            await session.closeGate;
            session.closed = true;
          },
          ownsSharedFeed: () => false,
          cancelPcm() {},
        },
        start(_profile, input) {
          if (challenge && !input.probe) {
            setTimeout(() => event('state', 'password'), 0);
          } else event('state', challenge ? 'password' : 'connected');
          return Promise.resolve();
        },
      };
    },
  });
  const speakers = createSpeakers({
    outputs,
    adapterView: devices.describe,
    prepare: devices.preparePlayback,
  });
  const library = createLibrary(store), nowPlaying = createNowPlaying(store);
  const reports = createPlaybackReports({
    nowPlaying,
    library,
    notify,
    serverRows: () => players.serverRows(),
  });
  const boots = new Map<number, PlayerBoot>();
  const players = await createPlayers({
    store,
    persistence,
    outputs,
    reports,
    notify,
    maxResumeAgeMs: 300000,
    clock: { monotonicNow: () => 0 },
    playback: {
      library,
      nowPlaying,
      cfg: {},
      resolveQueueReference: async (ref) => {
        const song = ref.kind === 'song' ? await library.getSong(ref.id) : null;
        return song ? catalogMedia(song) : null;
      },
    },
    targets: (id) => ({
      hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
      preparePlayback: (signal) => speakers.preparePlayback(signal, id),
    }),
    createBoot(id, playback, outputs) {
      const boot = createAirplayBoot({
        playerId: id,
        playback,
        outputs,
        devices,
        notify,
        media: createMedia(),
        retryBackoffMs: [1000],
        retryTimer: {
          set: (callback) => {
            timers.push(callback);
            return { cancel() {} };
          },
        },
      });
      boots.set(id, boot);
      return boot;
    },
  });
  const other = await players.create('Other');
  const [song] = await library.listSongs({ offset: 0, size: 1 });
  for (const id of [1, other.id]) await players.get(id).queueAdd([song]);
  outputs.register({
    id: 's',
    name: 'Speaker',
    type: 'AirPlay',
    host: '127.0.0.1',
    port: 7000,
    selected: false,
    volume: 80,
  });
  await players.join(other.id, 's');
  return {
    outputs,
    devices,
    players,
    speakers,
    credentials,
    sessions,
    timers,
    boots,
    other: other.id,
    setLookup: (next: typeof lookup) => lookup = next,
    challenge: () => challenge = true,
    async close() {
      await players.close();
      await reports.close();
      devices.close();
      await persistence.drain();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('transfer retires the former owner and waits for its actual cleanup before new PCM', async () => {
  const f = await household(), held = deferred<void>();
  try {
    await f.players.get(f.other).play();
    await until(() => f.sessions[0]?.bytes > 0);
    const old = f.sessions[0];
    old.closeGate = held.promise;
    const physical = f.outputs.revision('s');
    await f.players.join(1, 's');
    await until(() => old.closing);
    await f.players.get(1).play();
    await sleep(30);
    assertEquals(f.sessions.length, 1, 'new owner must wait for actual close');
    assertEquals(f.players.get(f.other).playerView().state, 'pause');
    assertEquals(f.players.get(f.other).queueView().items.length, 1);
    old.event('state', 'password');
    assertEquals(f.devices.describe('s').session?.authentication, 'none');
    held.resolve();
    await until(() => f.sessions[1]?.bytes > 0);
    assert(old.closed);
    assertEquals(f.outputs.revision('s'), physical);
    assertEquals(f.players.get(f.other).playerView().state, 'pause');
    assertEquals(f.players.get(1).playerView().state, 'play');
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('late retry timers cannot resume a membership that moved away and back', async () => {
  const f = await household();
  try {
    await f.players.get(f.other).play();
    await until(() => f.sessions[0]?.bytes > 0);
    f.sessions[0].event('state', 'failed');
    await until(() => f.timers.length > 0);
    const retry = f.timers[0];
    await f.players.join(1, 's');
    await f.players.join(f.other, 's');
    retry();
    await sleep(30);
    assertEquals(f.sessions.length, 1);
    assertEquals(f.players.get(f.other).playerView().state, 'pause');
    await assertRejects(
      () => f.boots.get(1)!.retry('s'),
      Error,
      'another player',
    );
    await f.players.get(f.other).play();
    await until(() => f.sessions[1]?.bytes > 0);
  } finally {
    await f.close();
  }
});

Deno.test('failed former-owner cleanup cannot admit the new owner to the same receiver', async () => {
  const f = await household(), held = deferred<void>();
  try {
    await f.players.get(f.other).play();
    await until(() => f.sessions[0]?.bytes > 0);
    f.sessions[0].closeGate = held.promise;
    await f.players.join(1, 's');
    await f.players.get(1).play();
    held.reject(new Error('controlled cleanup failure'));
    await until(() => f.devices.describe('s').session?.connection === 'failed');
    assertEquals(f.sessions.length, 1);
    assertEquals(f.sessions[0].closed, false);
    assertEquals(f.players.get(1).playerView().state, 'pause');
    f.sessions[0].event('state', 'connected');
    assertEquals(f.devices.describe('s').session?.connection, 'failed');
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('credential renewal saves household credentials but cannot resume a transferred membership', async () => {
  const f = await household(),
    held = deferred<void>(),
    entered = deferred<void>();
  try {
    await f.players.get(f.other).play();
    await until(() => f.sessions[0]?.bytes > 0);
    const change = f.boots.get(f.other)!.changeCredentials('s', async () => {
      entered.resolve();
      await held.promise;
      await f.credentials.set('s', 'password', 'household-secret');
    });
    await entered.promise;
    await f.players.join(1, 's');
    await f.players.join(f.other, 's');
    held.resolve();
    await change;
    await sleep(30);
    assertEquals(await f.credentials.get('s', 'password'), 'household-secret');
    assertEquals(f.sessions.length, 1);
    assertEquals(f.players.get(f.other).playerView().state, 'pause');
  } finally {
    held.resolve();
    await f.close();
  }
});

for (const mode of ['explicit', 'playback'] as const) {
  Deno.test(`${mode} pairing continuations and receipts cannot cross transfer away and back`, async () => {
    const f = await household();
    try {
      f.challenge();
      await f.credentials.set('s', 'pairing-key', 'a'.repeat(128));
      if (mode === 'explicit') {
        assertEquals(
          (await f.boots.get(f.other)!.pair('s')).state,
          'awaiting_pin',
        );
      } else {
        await f.players.get(f.other).play();
        await until(() =>
          f.devices.describe('s').session?.authentication ===
            'authentication_required'
        );
        assertEquals(
          (await f.boots.get(f.other)!.submitPin('s', '1234')).state,
          'pairing',
        );
      }
      const old = f.sessions[0];
      await f.players.join(1, 's');
      await f.players.join(f.other, 's');
      await assertRejects(
        () =>
          old.credential!({
            revision: 1n,
            key: 'b'.repeat(128),
            isCurrent: () => true,
          }),
        Error,
      );
      old.event('credential', 'saved');
      old.event('state', 'stopped');
      await assertRejects(
        () => f.boots.get(f.other)!.submitPin('s', '1234'),
        Error,
        'Begin pairing',
      );
      assertEquals(
        await f.credentials.get('s', 'pairing-key'),
        'a'.repeat(128),
      );
      assertEquals(f.devices.describe('s').session?.connection, 'disconnected');
      assertEquals(f.players.get(1).playerView().state, 'stop');
      assertEquals(f.sessions.length, 1);
    } finally {
      await f.close();
    }
  });
}

Deno.test('delayed explicit pairing cannot start after a membership round trip', async () => {
  const f = await household(),
    held = deferred<ReturnType<typeof receiver>>(),
    entered = deferred<void>();
  try {
    f.setLookup(() => {
      entered.resolve();
      return held.promise;
    });
    const pairing = f.boots.get(f.other)!.pair('s');
    await entered.promise;
    await f.players.join(1, 's');
    await f.players.join(f.other, 's');
    held.resolve(receiver(1, 7000, { sf: '200' }));
    assertEquals((await pairing).state, 'cancelled');
    assertEquals(f.sessions.length, 0);
    assertEquals(f.devices.describe('s').session?.connection, 'disconnected');
  } finally {
    held.resolve(receiver(1, 7000));
    await f.close();
  }
});

Deno.test('forget targets its non-default owner and waits for temporary transport release', async () => {
  const f = await household(), held = deferred<void>();
  try {
    await f.outputs.adopt('s');
    await f.players.get(f.other).play();
    await until(() => f.sessions[0]?.bytes > 0);
    f.sessions[0].closeGate = held.promise;
    let forgotten = false;
    const forget = f.speakers.forget('s').then(() => forgotten = true);
    await until(() => f.sessions[0].closing);
    assertEquals(f.players.get(f.other).playerView().state, 'pause');
    assertEquals(f.players.get(1).playerView().state, 'stop');
    assertEquals(forgotten, false);
    held.resolve();
    await forget;
    assertEquals(f.outputs.get('s'), null);
    assertEquals(f.players.get(f.other).queueView().items.length, 1);
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('withdrawn temporary preparation cannot publish after transfer away and back', async () => {
  const f = await household(),
    held = deferred<ReturnType<typeof receiver>>(),
    entered = deferred<void>();
  try {
    f.setLookup(() => {
      entered.resolve();
      return held.promise;
    });
    const playing = f.players.get(f.other).play();
    const rejected = assertRejects(
      async () => await playing,
      PlaybackError,
      'cancelled',
    );
    await entered.promise;
    f.outputs.withdraw('s');
    assertEquals(f.players.members(f.other).length, 1);
    await f.players.join(1, 's');
    await f.players.join(f.other, 's');
    held.resolve(receiver(1, 7000, { sf: '200' }));
    await rejected;
    await sleep(30);
    assertEquals(f.sessions.length, 0);
    assertEquals(f.players.get(f.other).playerView().state, 'stop');
    assertEquals(f.outputs.lifetime('s').adopted, false);
    assertEquals(f.devices.describe('s').preparation.state, 'unresolved');
  } finally {
    held.resolve(receiver(1, 7000));
    await f.close();
  }
});

Deno.test('delayed credential loading cannot construct a transport for a former membership', async () => {
  const f = await household(),
    held = deferred<void>(),
    entered = deferred<void>();
  const session = f.credentials.session;
  try {
    f.credentials.session = async (...args) => {
      const snapshot = await session(...args);
      entered.resolve();
      await held.promise;
      return snapshot;
    };
    await f.players.get(f.other).play();
    await entered.promise;
    await f.players.join(1, 's');
    await f.players.join(f.other, 's');
    held.resolve();
    await sleep(30);
    assertEquals(f.sessions.length, 0);
    assertEquals(f.players.get(f.other).playerView().state, 'pause');
    f.credentials.session = session;
    await f.players.get(f.other).play();
    await until(() => f.sessions[0]?.bytes > 0);
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('retry resumption held in preflight cannot outlive its membership', async () => {
  const f = await household(),
    held = deferred<ReturnType<typeof receiver>>(),
    entered = deferred<void>();
  try {
    await f.players.get(f.other).play();
    await until(() => f.sessions[0]?.bytes > 0);
    f.sessions[0].event('state', 'failed');
    await until(() => f.timers.length > 0 && f.sessions[0].closed);
    f.devices.admission.invalidate('s');
    f.setLookup(() => {
      entered.resolve();
      return held.promise;
    });
    f.timers[0]();
    await entered.promise;
    await f.players.join(1, 's');
    await f.players.join(f.other, 's');
    held.resolve(receiver(1, 7000, { sf: '200' }));
    await sleep(30);
    assertEquals(f.sessions.length, 1);
    assertEquals(f.players.get(f.other).playerView().state, 'pause');
    assertEquals(f.players.get(1).playerView().state, 'stop');
    await f.players.get(f.other).play();
    await until(() => f.sessions[1]?.bytes > 0);
  } finally {
    held.resolve(receiver(1, 7000));
    await f.close();
  }
});
