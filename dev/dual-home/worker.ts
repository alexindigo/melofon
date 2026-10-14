import { serve } from './rpc.ts';
import { startFakeRaop } from '../../tests/helpers/fake-raop.ts';
import { decodeReceiverAudio } from '../../tests/helpers/raop-audio-consumer.ts';
import { pcmAt } from './fixture.ts';
import type { Library, SongRow } from '../../src/library.ts';
import type { NowPlaying } from '../../src/nowplaying.ts';
import type { State } from '../../src/state.ts';
import type { AirplaySpawn } from '../../src/boots/airplay-profile.ts';

export interface ReceiverSession {
  id: string;
  rtspPeer: { address: string; port: number };
  announceSource: string | null;
  rtpSenders: { address: string; port: number; atMs: number }[];
  controlSenders: { address: string; port: number; atMs: number }[];
  timingSenders: { address: string; port: number; atMs: number }[];
  closedAtMs: number | null;
  firstRtpAtMs: number | null;
  lastRtpAtMs: number | null;
  audioPackets: number;
  methods: string[];
  requests: { method: string; cseq: string; atMs: number }[];
  decodedFrames: number;
  decodedStartFrame: number | null;
  exactPcm: boolean;
  tailExactPcm: boolean;
  tailFrame: number | null;
}
export interface SenderStatus {
  events: {
    target: string;
    event: string;
    value?: string;
    atMs: number;
    bookmarkMs: number;
  }[];
  decodes: { startMs: number; atMs: number }[];
  state: string;
  progressMs: number;
  selected: boolean;
  connectionInodes: string[];
  pcmSpans: {
    target: string;
    firstFrame: number;
    lastFrame: number;
    atMs: number;
  }[];
  releases: { target: string; startedAtMs: number; completedAtMs: number }[];
}

async function ownedConnectionInodes() {
  const owned = new Set<string>();
  for await (const entry of Deno.readDir('/proc/self/fd')) {
    try {
      const link = await Deno.readLink(`/proc/self/fd/${entry.name}`);
      const match = link.match(/^socket:\[(\d+)\]$/);
      if (match) owned.add(match[1]);
    } catch { /* fd closed concurrently on native thread */ }
  }
  const result: string[] = [];
  for (const protocol of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const table = await Deno.readTextFile(`/proc/self/net/${protocol}`);
    for (const line of table.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // Linux /proc IPv4 words are little-endian: 203.0.113.10 = 0A7100CB.
      if (owned.has(fields[9]) && fields[2].startsWith('0A7100CB:')) {
        result.push(fields[9]);
      }
    }
  }
  return result;
}

export async function receiver(ready: string, startup: boolean) {
  while (true) {
    try {
      await Deno.stat(ready);
      break;
    } catch { /* topology being configured */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const primary = await startFakeRaop({
    bindAddress: '203.0.113.10',
    captureAudio: true,
    probeChannels: true,
    ...(startup ? { setupDelayMs: 1200 } : {}),
  });
  const peer = await startFakeRaop({
    bindAddress: '203.0.113.11',
    captureAudio: true,
    probeChannels: true,
  });
  await serve((command, input) => {
    if (command === 'ports') return { primary: primary.port, peer: peer.port };
    if (command === 'retransmit') {
      primary.requestRetransmit(String(input.id));
      return true;
    }
    if (command === 'close') {
      primary.close();
      peer.close();
      return true;
    }
    if (command !== 'snapshot') throw new Error('unknown receiver command');
    return [primary, peer].map((fake) =>
      fake.sessions.map((session) => {
        let frames = 0, first: number | null = null, exact = true;
        if (session.audioPayloads.length) {
          const pcm = decodeReceiverAudio(
            session.sdp,
            session.audioPayloads.slice(0, 128),
          );
          const samples = new DataView(
            pcm.buffer,
            pcm.byteOffset,
            pcm.byteLength,
          );
          frames = pcm.length / 4;
          const left = samples.getInt16(0, true),
            right = samples.getInt16(2, true);
          first = (-right - 1000) * 20000 + left - 1000;
          for (let i = 0; i < frames; i++) {
            const [l, r] = pcmAt(first + i);
            if (
              samples.getInt16(i * 4, true) !== l ||
              samples.getInt16(i * 4 + 2, true) !== r
            ) {
              exact = false;
              break;
            }
          }
        }
        let tailFrame: number | null = null, tailExactPcm = true;
        for (const payload of session.audioPayloads.slice(-4)) {
          const tail = decodeReceiverAudio(session.sdp, [payload]);
          const samples = new DataView(
            tail.buffer,
            tail.byteOffset,
            tail.byteLength,
          );
          const start = (-samples.getInt16(2, true) - 1000) * 20000 +
            samples.getInt16(0, true) - 1000;
          for (let i = 0; i < tail.length / 4; i++) {
            const [l, r] = pcmAt(start + i);
            if (
              samples.getInt16(i * 4, true) !== l ||
              samples.getInt16(i * 4 + 2, true) !== r ||
              start + i >= 180 * 44100
            ) {
              tailExactPcm = false;
              break;
            }
          }
          tailFrame = start + tail.length / 4 - 1;
        }
        return {
          id: session.id,
          rtspPeer: session.rtspPeer,
          announceSource:
            session.sdp.match(/o=iTunes \d+ 0 IN IP4 ([^\r\n]+)/)?.[1] ?? null,
          rtpSenders: session.rtpSenders,
          controlSenders: session.controlSenders,
          timingSenders: session.timingSenders,
          closedAtMs: session.closedAtMs,
          firstRtpAtMs: session.firstRtpAtMs,
          lastRtpAtMs: session.lastRtpAtMs,
          audioPackets: session.audioPackets,
          methods: session.requests.map((r) => r.method),
          requests: session.requests,
          decodedFrames: frames,
          decodedStartFrame: first,
          exactPcm: exact,
          tailFrame,
          tailExactPcm,
        } satisfies ReceiverSession;
      })
    );
  });
}

export async function sender(root: string, library: string) {
  Deno.env.set('MELOFON_RAOP_LIB', library);
  // Every production module is selected from the requested candidate, including
  // transitive imports. Shared receiver/driver code never selects the coordinator.
  const module = (path: string) =>
    import(new URL(path, `file://${root}/`).href);
  const { createNotify } = await module('src/notify.ts');
  const { createOutputs, createPlayer } = await module('src/player.ts');
  const { createPlayback } = await module('src/playback.ts');
  const { createMedia } = await module('src/media.ts');
  const { createAirplayDevices } = await module('src/boots/airplay-device.ts');
  const { createAirplayBoot } = await module('src/boots/airplay.ts');
  const { createFfiSpawn } = await module('src/boots/raop-ffi.ts');
  const events: SenderStatus['events'] = [],
    decodes: SenderStatus['decodes'] = [];
  const pcmSpans: SenderStatus['pcmSpans'] = [];
  const releases: SenderStatus['releases'] = [];
  const started = performance.now();
  const notify = createNotify(), outputs = createOutputs({ notify });
  const playback = createPlayback({
    notify,
    outputs,
    player: createPlayer(),
    cfg: {},
    library: {} as Library,
    nowPlaying: {} as NowPlaying,
  });
  const real = createMedia();
  const media = {
    ...real,
    decodePcm(path: string, options?: { startMs?: number }) {
      decodes.push({
        startMs: options?.startMs ?? 0,
        atMs: performance.now() - started,
      });
      return real.decodePcm(path, options);
    },
  };
  let boot: { close(): Promise<void> } | undefined;
  const spawn: AirplaySpawn = (callback) => {
    let target = '';
    const driver = createFfiSpawn()((event: string, value?: string) => {
      events.push({
        target,
        event,
        value,
        atMs: performance.now() - started,
        bookmarkMs: playback.playerView().itemProgressMs,
      });
      callback(event, value);
    });
    const pcm = driver.transport.pcm.bind(driver.transport);
    const close = driver.transport.close.bind(driver.transport);
    driver.transport.close = async () => {
      const startedAtMs = performance.now() - started;
      await close();
      releases.push({
        target,
        startedAtMs,
        completedAtMs: performance.now() - started,
      });
    };
    driver.transport.pcm = async (data: Uint8Array) => {
      await pcm(data);
      if (
        driver.transport.ownsSharedFeed() && data.length >= 4 &&
        pcmSpans.length < 2048
      ) {
        const samples = new DataView(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
        const firstFrame = (-samples.getInt16(2, true) - 1000) * 20000 +
          samples.getInt16(0, true) - 1000;
        pcmSpans.push({
          target,
          firstFrame,
          lastFrame: firstFrame + data.length / 4 - 1,
          atMs: performance.now() - started,
        });
      }
    };
    return {
      transport: driver.transport,
      start(profile, input) {
        target = profile.host;
        return driver.start(profile, input);
      },
    };
  };
  const devices = createAirplayDevices({
    outputs,
    spawn,
    resolver: {
      resolve() {
        return Promise.reject(
          new Error('only explicit acquired fixture observations allowed'),
        );
      },
      close() {},
    },
  });
  await serve(async (command, input) => {
    if (command === 'start') {
      const ports = input.ports as { primary: number; peer: number };
      const retry = input.retry as string;
      const state = {
        get: () => Promise.resolve(retry),
        onChange: () => () => {},
      } as unknown as State;
      boot = createAirplayBoot({
        outputs,
        playback,
        notify,
        devices,
        media,
        state,
      });
      for (
        const [id, address, port] of [
          ['1', '203.0.113.10', ports.primary],
          ...(input.peer ? [['2', '203.0.113.11', ports.peer]] : []),
        ] as [string, string, number][]
      ) {
        devices.register(
          {
            id,
            host: address,
            port,
            name: id,
            type: 'AirPlay',
            selected: true,
            volume: 100,
            connectionStrategy: input.strategy,
          },
          undefined,
          {
            name: `001122334455@${id}._raop._tcp.local`,
            host: 'fixture.local',
            address,
            port,
            ttlMs: 3600000,
            txt: {
              tp: 'UDP',
              am: 'AppleTV3,1',
              sr: '44100',
              ss: '16',
              ch: '2',
            },
          },
        );
      }
      const song: SongRow = {
        id: 'dual-home',
        path: String(input.fixture),
        title: 'Dual home proof',
        durationMs: 180000,
        libraryId: null,
        libraryPath: null,
        albumId: null,
        albumName: null,
        artistId: null,
        artistName: null,
        track: 1,
        disc: 1,
        size: 180 * 176400 + 44,
        genre: null,
        year: null,
        isVideo: false,
        suffix: 'wav',
        contentType: 'audio/wav',
      };
      playback.queueAdd([song], { play: true });
      playback.seek({ positionMs: 20000 });
      return true;
    }
    if (command === 'pause') playback.pause();
    else if (command === 'stop') playback.stop();
    else if (command === 'deselect') outputs.update('1', { selected: false });
    else if (command === 'close') {
      await boot?.close();
      devices.close();
      playback.close();
      return true;
    } else if (command !== 'snapshot') {
      throw new Error('unknown sender command');
    }
    const view = playback.playerView();
    return {
      events,
      decodes,
      state: view.state,
      progressMs: view.itemProgressMs,
      selected: outputs.get('1')?.selected ?? false,
      connectionInodes: await ownedConnectionInodes(),
      pcmSpans,
      releases,
    } satisfies SenderStatus;
  });
}
