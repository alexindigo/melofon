// Attribute actual receiver bytes using explicit native transport ranges. Never
// allow an arbitrary PCM suffix: every extra transport frame is labelled and zero.
import { assert, assertEquals } from '@std/assert';
import type {
  AirplayRangeSnapshot,
  AirplayTimelineStream,
} from '../../src/boots/airplay-profile.ts';
import type { FakeRaopSession } from './fake-raop.ts';
import { decodeReceiverAudio } from './raop-audio-consumer.ts';
import { renderScheduledAudio } from './raop-scheduled-consumer.ts';

export function traceTimelineAudio(factory: () => AirplayTimelineStream) {
  const epochs: { id: bigint; ranges: AirplayRangeSnapshot[] }[] = [];
  return {
    epochs,
    stream() {
      const native = factory();
      return {
        ...native,
        get epoch() {
          return native.epoch;
        },
        async waitCompletion(
          key: Parameters<AirplayTimelineStream['waitCompletion']>[0],
        ) {
          const result = await native.waitCompletion(key);
          if (
            result.status === 'complete' &&
            !epochs.some((e) => e.id === key.epoch)
          ) {
            const ranges: AirplayRangeSnapshot[] = [];
            for (let i = 0n;; i++) {
              const range = await native.range(key.epoch, i);
              if (!range) break;
              ranges.push(range);
            }
            epochs.push({ id: key.epoch, ranges });
          }
          return result;
        },
      };
    },
    realAudio(session: FakeRaopSession, firstEpoch = 0) {
      const payloads: Uint8Array[][] = [];
      let current: Uint8Array[] | undefined;
      for (const event of session.wire) {
        if (event.kind === 'record' || event.kind === 'flush') {
          current = [];
          payloads.push(current);
        } else if (event.kind === 'audio') {
          assert(current);
          current.push(event.data.subarray(12));
        }
      }
      const pieces: Uint8Array[] = [];
      for (const [i, epoch] of epochs.entries()) {
        const received = decodeReceiverAudio(
          session.sdp,
          payloads[firstEpoch + i] ?? [],
        );
        let accounted = 0;
        for (const range of epoch.ranges) {
          const start = Number(range.transportStart) * 4;
          const end = Math.min(
            received.length,
            start + Number(range.frames) * 4,
          );
          if (start >= received.length) break;
          assertEquals(start, accounted, 'transport has no unlabelled gap');
          const part = received.subarray(start, end);
          if (range.kind === 'real') {
            assertEquals(
              part.length,
              Number(range.frames) * 4,
              'all real frames reached receiver',
            );
            pieces.push(part);
          } else {assertEquals(
              part,
              new Uint8Array(part.length),
              `${range.kind} is exactly zero`,
            );}
          accounted = end;
        }
        assertEquals(
          accounted,
          received.length,
          'every extra transport byte has an explicit silence range',
        );
      }
      const result = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const piece of pieces) {
        result.set(piece, at);
        at += piece.length;
      }
      return result;
    },
    scheduledRealAudio(
      session: FakeRaopSession,
      throughMs: number,
      firstEpoch = 0,
    ) {
      const replay = renderScheduledAudio(session, throughMs);
      assertEquals(replay.issues, []);
      const anchors = session.wire.flatMap((e) =>
        e.kind === 'record' || e.kind === 'flush'
          ? [Number(/rtptime=(\d+)/.exec(e.rtpInfo)![1])]
          : []
      );
      const pieces: Uint8Array[] = [];
      for (const [i, epoch] of epochs.entries()) {
        const scheduled = replay.ranges.filter((r) =>
          r.epoch === firstEpoch + i + 1
        ).map((r) => ({
          ...r,
          offset: (r.timestamp - anchors[firstEpoch + i] + 2 ** 32) % 2 ** 32,
        }));
        for (const range of epoch.ranges) {
          const start = Number(range.transportStart),
            end = start + Number(range.frames);
          let real = start;
          for (const r of scheduled) {
            const low = Math.max(start, r.offset),
              high = Math.min(end, r.offset + r.frames);
            if (high <= low) continue;
            const part = r.pcm.subarray(
              (low - r.offset) * 4,
              (high - r.offset) * 4,
            );
            if (range.kind === 'real') {
              assertEquals(
                low,
                real,
                'scheduled real-source coverage has no missing prefix or hole',
              );
              real = high;
              pieces.push(part);
            } else {assertEquals(
                part,
                new Uint8Array(part.length),
                `scheduled ${range.kind} is zero`,
              );}
          }
          if (range.kind === 'real') {
            assertEquals(
              real,
              end,
              'every real frame renders before transition',
            );
          }
        }
      }
      const result = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const piece of pieces) {
        result.set(piece, at);
        at += piece.length;
      }
      return result;
    },
  };
}
