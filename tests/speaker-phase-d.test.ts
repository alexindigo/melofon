import { assert, assertEquals } from '@std/assert';
import {
  receiver,
  speakerConsumer,
  speakerMedia,
  until,
} from './helpers/speaker-consumer.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';

Deno.test({
  name:
    'phase D real HTTP discovery adoption ignore forget temporary audio password reopen and no-speaker refusal',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: 'speaker-phase-d-' });
    const pcm = await speakerMedia(dir),
      root = crypto.randomUUID(),
      password = crypto.randomUUID();
    const plain = await startFakeRaop({ captureAudio: true });
    const protectedSpeaker = await startFakeRaop({
      captureAudio: true,
      digest: { password },
    });
    const services = [
      receiver(1, plain.port),
      receiver(2, protectedSpeaker.port, { pw: 'true' }),
    ];
    let t: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
    const reopen = async () => {
      await t?.close();
      t = undefined;
      t = await speakerConsumer(dir, services, { root });
    };
    const consume = async (fake: typeof plain, index: number) => {
      await until(() => (fake.sessions[index]?.audioPackets ?? 0) > 160);
      const session = fake.sessions[index];
      const received = decodeReceiverAudio(session.sdp, session.audioPayloads);
      const offset = Math.round(t!.decodedStart() * 44100 / 1000) * 4;
      assert(received.length > 176400 && received.some((n) => n !== 0));
      assert(
        received.every((n, i) => n === pcm[offset + i]),
        'Exact decoded receiver PCM',
      );
    };
    const ok = async (r: Response, code: number) => {
      assertEquals(r.status, code);
      await r.text();
    };
    try {
      await reopen();
      for (const service of services) t!.discover(service);
      assertEquals((await t!.read('1')).adopted, false);
      await ok(await t!.write('1', 'adopt'), 200);
      await reopen();
      assertEquals((await t!.read('1')).adopted, true);
      for (const service of services) t!.discover(service);
      await ok(await t!.write('2', 'ignore'), 200);
      await reopen();
      t!.discover(services[1]);
      const hidden = await t!.f.get('/api/v1/speakers/2', t!.credential);
      assertEquals(hidden.status, 404);
      await hidden.text();
      await ok(await t!.write('2', 'ignore', 'DELETE'), 204);
      assertEquals((await t!.read('2')).adopted, false);
      await ok(await t!.write('1', '', 'DELETE'), 204);
      await reopen();
      assertEquals(t!.outputs.list(), []);
      t!.discover(services[0]);
      await t!.play('1');
      await consume(plain, 0);
      assertEquals((await t!.read('1')).adopted, false);
      assertEquals(await t!.f.store.speakers.loadAdopted(), []);
      await t!.own('/player/stop', 'PUT');
      await reopen();
      assertEquals(t!.outputs.list(), []);
      const refused = await t!.ownResponse('/player/play', 'PUT');
      assertEquals(refused.status, 500);
      assert(
        (await refused.text()).includes('Select a speaker before playing'),
      );
      assertEquals(t!.playback.playerView().state, 'pause');
      t!.discover(services[1]);
      await ok(await t!.write('2', 'password', 'PUT', { password }), 200);
      await ok(await t!.write('2', 'adopt'), 200);
      await t!.play('2');
      await consume(protectedSpeaker, 0);
      assert(protectedSpeaker.sessions[0].authChallenges > 0);
      await t!.own('/player/stop', 'PUT');
      await reopen();
      assertEquals((await t!.read('2')).adopted, true);
      await t!.play('2');
      await consume(protectedSpeaker, 1);
      assert(protectedSpeaker.sessions[1].acceptedRequests.includes('RECORD'));
    } finally {
      await t?.close();
      plain.close();
      protectedSpeaker.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
