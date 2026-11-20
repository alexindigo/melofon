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
  const epochs: {
    id: bigint;
    ranges: AirplayRangeSnapshot[];
    completedThrough: bigint;
  }[] = [];
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
          if (result.status === 'complete') {
            let epoch = epochs.find((e) => e.id === key.epoch);
            if (!epoch) {
              epoch = { id: key.epoch, ranges: [], completedThrough: 0n };
              epochs.push(epoch);
            }
            if (result.transportEnd > epoch.completedThrough) {
              epoch.completedThrough = result.transportEnd;
            }
            for (let i = 0n;; i++) {
              const range = await native.range(key.epoch, i);
              if (!range) break;
              const existing = epoch.ranges.findIndex((r) =>
                r.transportStart === range.transportStart
              );
              if (existing < 0) epoch.ranges.push(range);
              else epoch.ranges[existing] = range;
            }
            epoch.ranges.sort((a, b) =>
              a.transportStart < b.transportStart
                ? -1
                : a.transportStart > b.transportStart
                ? 1
                : 0
            );
          }
          return result;
        },
      };
    },
    realAudio(session: FakeRaopSession, firstEpoch = 0, completedOnly = false) {
      // RTSP and UDP are independently delivered. Arrival after FLUSH does not
      // grant an old datagram authority in the replacement epoch. Attribute by
      // RTP location, retaining hole/conflicting-duplicate checks before decode.
      const payloads: Map<number, Uint8Array>[] = [];
      let current: Map<number, Uint8Array> | undefined;
      let anchor = 0, sequence = 0, highest = 0;
      for (const event of session.wire) {
        if (event.kind === 'record' || event.kind === 'flush') {
          const info = /^seq=(\d+);rtptime=(\d+)$/.exec(event.rtpInfo);
          assert(info, 'arrival epoch has valid RTP-Info');
          sequence = Number(info[1]);
          anchor = Number(info[2]);
          highest = 0;
          current = new Map();
          payloads.push(current);
        } else if (event.kind === 'audio') {
          assert(current);
          const header = new DataView(
            event.data.buffer,
            event.data.byteOffset,
            event.data.byteLength,
          );
          const rawOffset = header.getUint32(4) - anchor;
          const offset = rawOffset +
            Math.round((highest - rawOffset) / 2 ** 32) * 2 ** 32;
          if (offset < 0) continue; // in-flight old-epoch packet
          assertEquals(
            offset % 352,
            0,
            'RTP timestamp has whole packet offset',
          );
          assertEquals(
            header.getUint16(2),
            (sequence + offset / 352) % 65536,
            'RTP sequence agrees with timestamp',
          );
          highest = Math.max(highest, offset);
          const bytes = event.data.subarray(12), previous = current.get(offset);
          if (previous) assertEquals(bytes, previous, 'RTP duplicate agrees');
          else current.set(offset, bytes);
        }
      }
      const pieces: Uint8Array[] = [];
      for (const [i, epoch] of epochs.entries()) {
        const packets = [...(payloads[firstEpoch + i] ?? new Map()).entries()]
          .sort(([a], [b]) => a - b);
        for (const [index, [offset]] of packets.entries()) {
          assertEquals(offset, index * 352, 'arrival coverage has no RTP hole');
        }
        const decoded = decodeReceiverAudio(
          session.sdp,
          packets.map(([, bytes]) => bytes),
        );
        // A continuous epoch also contains accepted future audio. A completed
        // source proof stops at its exact retained native boundary, not at an
        // arbitrary suffix allowance or an arrival-time guess.
        const received = completedOnly
          ? decoded.subarray(0, Number(epoch.completedThrough) * 4)
          : decoded;
        let accounted = 0;
        for (const original of epoch.ranges) {
          const range = completedOnly
            ? {
              ...original,
              frames: original.transportStart + original.frames >
                  epoch.completedThrough
                ? epoch.completedThrough - original.transportStart
                : original.frames,
            }
            : original;
          if (range.frames <= 0n) break;
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
      completedOnly = false,
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
        for (const original of epoch.ranges) {
          const range = completedOnly
            ? {
              ...original,
              frames: original.transportStart + original.frames >
                  epoch.completedThrough
                ? epoch.completedThrough - original.transportStart
                : original.frames,
            }
            : original;
          if (range.frames <= 0n) break;
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
