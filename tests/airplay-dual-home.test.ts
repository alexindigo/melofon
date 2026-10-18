// Ordinary failed-event authority contracts. Native source detection is
// covered by tests/raop-source-probe.test.ts.
import { assert, assertEquals } from '@std/assert';
import { createNotify } from '../src/notify.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createAirplayBoot, type HelperEventFn } from '../src/boots/airplay.ts';
import {
  createTestAirplayDevices,
  recordingSpawn,
} from './helpers/airplay-devices.ts';
import type { Library, SongRow } from '../src/library.ts';
import type { NowPlaying } from '../src/nowplaying.ts';
import type { Media } from '../src/media.ts';
import type { State } from '../src/state.ts';
import type { ConnectionStrategy } from '../src/connection-strategy.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const end = performance.now() + 2000;
  while (!predicate()) {
    assert(performance.now() < end, 'authority outcome within bound');
    await sleep(2);
  }
}
class Transport {
  commands: Record<string, unknown>[] = [];
  bytes: number[] = [];
  closed = false;
  generation = 0;
  gate: Promise<void> | null = null;
  constructor(readonly event: HelperEventFn) {}
  send(command: Record<string, unknown>) {
    this.commands.push(command);
    return Promise.resolve();
  }
  ownsSharedFeed() {
    return false;
  }
  cancelPcm() {
    this.generation++;
  }
  pcm(data: Uint8Array) {
    if (!this.closed) this.bytes.push(data[0]);
    return Promise.resolve();
  }
  async close() {
    if (this.gate) await this.gate;
    this.closed = true;
  }
}
function fixture(choice: ConnectionStrategy, retry = '0,0') {
  const notify = createNotify(), outputs = createOutputs({ notify });
  const playback = createPlayback({
    notify,
    player: createPlayer(),
    cfg: {},
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
  });
  const transports: Transport[] = [], starts: number[] = [];
  const devices = createTestAirplayDevices(
    outputs,
    recordingSpawn((event) => {
      const transport = new Transport(event);
      transports.push(transport);
      return transport;
    }),
  );
  const media = {
    decodePcm(_path: string, options?: { startMs?: number }) {
      starts.push(options?.startMs ?? 0);
      const tag = starts.length;
      return Promise.resolve({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 10000; i++) {
            await sleep(2);
            yield new Uint8Array([tag]);
          }
        },
      });
    },
  } as unknown as Media;
  const state = {
    declare() {},
    get: () => Promise.resolve(retry),
    onChange: () => () => {},
  } as unknown as State;
  const boot = createAirplayBoot({
    outputs,
    playback,
    notify,
    devices,
    media,
    state,
  });
  const register = (id = '1') =>
    outputs.register({
      id,
      type: 'AirPlay',
      name: id,
      host: `192.0.2.${id}`,
      connectionStrategy: choice,
      selected: true,
      volume: 100,
    });
  const song = {
    id: 'fixture',
    path: '/fixture',
    durationMs: 3600000,
  } as SongRow;
  return {
    playback,
    outputs,
    transports,
    starts,
    register,
    async play(connect = true) {
      register();
      playback.queueAdd([song], { play: true });
      playback.seek({ positionMs: 30000 });
      await until(() => transports.length === 1);
      if (!connect) return;
      transports[0].event('state', 'connected');
      await until(() => transports[0].bytes.length > 0);
    },
    async close() {
      await boot.close();
      devices.close();
      playback.close();
    },
  };
}

for (const choice of ['melofon', 'owntone', 'audiostation'] as const) {
  Deno.test(`dual-home ${choice}: connecting generation honors a seek before CONNECTED`, async () => {
    const s = fixture(choice, 'off');
    try {
      await s.play(false);
      const old = s.transports[0];
      s.playback.seek({ positionMs: 60000 });
      if (choice === 'owntone') {
        old.event('state', 'connected');
        await until(() => old.bytes.length > 0);
        assertEquals(s.transports.length, 1);
        assert(s.starts[0] >= 60000);
      } else {
        await until(() => old.closed && s.transports.length === 2);
        old.event('state', 'connected');
        assertEquals(old.bytes.length, 0);
        s.transports[1].event('state', 'connected');
        await until(() => s.transports[1].bytes.length > 0);
        assert(s.starts[0] >= 60000);
      }
    } finally {
      await s.close();
    }
  });
  Deno.test(`dual-home ${choice}: replacement waits for release and consumes the retained bookmark`, async () => {
    const s = fixture(choice);
    let release!: () => void;
    try {
      await s.play();
      const old = s.transports[0];
      old.gate = new Promise((resolve) => release = resolve);
      old.event('state', 'failed');
      const bookmark = s.playback.playerView().itemProgressMs;
      const bytes = old.bytes.length;
      old.event('state', 'failed');
      old.event('state', 'connected');
      await sleep(30);
      assertEquals(s.transports.length, 1, 'no transport before local release');
      assertEquals(
        old.bytes.length,
        bytes,
        'stale connected/failed cannot resume PCM',
      );
      assertEquals(s.playback.playerView().state, 'pause');
      release();
      await until(() => old.closed && s.transports.length === 2);
      const replacement = s.transports[1];
      replacement.event('state', 'connected');
      await until(() => replacement.bytes.length > 0);
      assert(
        s.starts.at(-1)! >= bookmark,
        'replacement decoding uses current bookmark',
      );
      assert(replacement.bytes[0] > old.bytes[0], 'fresh PCM generation');
      assertEquals(s.outputs.get('1')!.selected, true);
    } finally {
      release?.();
      await s.close();
    }
  });
  Deno.test(`dual-home ${choice}: retry off releases the target and preserves its bookmark`, async () => {
    const s = fixture(choice, 'off');
    try {
      await s.play();
      s.transports[0].event('state', 'failed');
      const bookmark = s.playback.playerView().itemProgressMs;
      await until(() => s.transports[0].closed);
      await sleep(50);
      assertEquals(s.transports.length, 1);
      assertEquals(s.playback.playerView().state, 'pause');
      assertEquals(s.playback.playerView().itemProgressMs, bookmark);
      assertEquals(s.outputs.get('1')!.selected, true);
    } finally {
      await s.close();
    }
  });
  for (const cancel of ['pause', 'stop', 'deselect'] as const) {
    Deno.test(`dual-home ${choice}: ${cancel} during old release revokes the replacement`, async () => {
      const s = fixture(choice);
      let release!: () => void;
      try {
        await s.play();
        const old = s.transports[0];
        old.gate = new Promise((resolve) => release = resolve);
        old.event('state', 'failed');
        if (cancel === 'deselect') s.outputs.update('1', { selected: false });
        else s.playback[cancel]();
        release();
        await until(() => old.closed);
        await sleep(50);
        assertEquals(s.transports.length, 1);
        assertEquals(
          s.playback.playerView().state,
          cancel === 'stop' ? 'stop' : 'pause',
        );
      } finally {
        release?.();
        await s.close();
      }
    });
  }
  Deno.test(`dual-home ${choice}: connected/source flaps exhaust one demand budget`, async () => {
    const s = fixture(choice, '0,0');
    try {
      await s.play();
      for (let i = 0; i < 3; i++) {
        const target = s.transports[i];
        target.event('state', 'failed');
        await until(() => target.closed);
        if (i < 2) {
          await until(() => s.transports.length === i + 2);
          s.transports[i + 1].event('state', 'connected');
          await until(() => s.transports[i + 1].bytes.length > 0);
        }
      }
      s.register();
      s.outputs.update('1', { volume: 70 });
      await sleep(50);
      assertEquals(s.transports.length, 3);
      assertEquals(s.playback.playerView().state, 'pause');
    } finally {
      await s.close();
    }
  });
  Deno.test(`dual-home ${choice}: unchanged peer consumes PCM while retry-off target is released`, async () => {
    const s = fixture(choice, 'off');
    try {
      await s.play();
      s.register('2');
      s.outputs.update('2', { selected: true });
      await until(() => s.transports.length === 2);
      const peer = s.transports[1];
      peer.event('state', 'connected');
      await until(() => peer.bytes.length > 0);
      const before = peer.bytes.length;
      s.transports[0].event('state', 'failed');
      await until(() => s.transports[0].closed && peer.bytes.length > before);
      assert(!peer.closed);
      assertEquals(s.transports.length, 2);
      assertEquals(s.playback.playerView().state, 'play');
    } finally {
      await s.close();
    }
  });
}
for (const command of ['pause', 'stop'] as const) {
  Deno.test(`dual-home OwnTone ${command} hold: obsolete sockets release without Play or deadline extension`, async () => {
    const s = fixture('owntone');
    try {
      await s.play();
      const old = s.transports[0];
      s.playback[command]();
      assert(!old.closed, 'OwnTone is actually in its idle hold');
      old.event('state', 'failed');
      await until(() => old.closed);
      await sleep(50);
      assertEquals(s.transports.length, 1);
      assertEquals(
        s.playback.playerView().state,
        command === 'stop' ? 'stop' : 'pause',
      );
    } finally {
      await s.close();
    }
  });
}
