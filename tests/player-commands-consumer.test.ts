import { assert, assertEquals } from '@std/assert';
import { startFakeRaop } from './helpers/fake-raop.ts';
import {
  receiver,
  speakerConsumer,
  speakerMedia,
  until,
} from './helpers/speaker-consumer.ts';

Deno.test('OwnTone previous uses 3 seconds; stop releases the receiver and resumes its bookmark across restart', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-command-consumer-' });
  const raop = await startFakeRaop({ captureAudio: true });
  const service = receiver(501, raop.port);
  let client: Awaited<ReturnType<typeof speakerConsumer>> | undefined;
  try {
    await speakerMedia(dir);
    client = await speakerConsumer(dir, [service]);
    client.discover(service);
    assertEquals((await client.write('501', 'adopt')).status, 200);
    await client.play('501');
    await until(() => raop.sessions.some((s) => s.audioPayloads.length >= 8));
    const song = client.playback.queueView().items[0];
    assert(song.facts.kind === 'song');
    const entries = await client.playback.queueAdd([song.facts.song]);
    await client.playback.next();
    await client.own('/player/seek?position_ms=4000', 'PUT');
    await client.own('/player/previous', 'PUT');
    assertEquals(client.playback.playerView().current?.id, entries[0].id);
    assert(client.playback.playerView().itemProgressMs < 1000);
    assertEquals(client.playback.lastCommand()?.kind, 'restart');
    await client.own('/player/seek?position_ms=2000', 'PUT');
    await client.own('/player/previous', 'PUT');
    assertEquals(client.playback.playerView().current?.id, song.id);
    assertEquals(client.playback.lastCommand()?.kind, 'previous');
    await client.own('/player/seek?position_ms=5000', 'PUT');
    await until(() =>
      raop.sessions.some((s) =>
        s.closedAtMs === null && s.audioPayloads.length >= 8
      )
    );
    await client.own('/player/stop', 'PUT');
    const stopped = client.playback.playerView();
    assertEquals(stopped.state, 'pause');
    assertEquals(stopped.current?.id, song.id);
    assert(stopped.itemProgressMs >= 5000);
    assertEquals(client.outputs.get('501')?.selected, true);
    await until(() => raop.sessions.every((s) => s.closedAtMs !== null));
    assert(raop.sessions.some((s) => s.teardowns > 0));
    await client.close();
    client = undefined;

    client = await speakerConsumer(dir, [service]);
    const restored = client.playback.playerView();
    assertEquals(restored.state, 'pause');
    assertEquals(restored.current?.id, song.id);
    assertEquals(restored.itemProgressMs, stopped.itemProgressMs);
    const oldSessions = raop.sessions.length;
    await client.own('/player/play', 'PUT');
    await until(() =>
      raop.sessions.slice(oldSessions).some((s) => s.audioPayloads.length >= 8)
    );
    assert(client.decodedStart() >= stopped.itemProgressMs);
    assertEquals(client.playback.playerView().current?.id, song.id);
    // Same-process stop/play preserves the bookmark and also opens a new session.
    await client.own('/player/stop', 'PUT');
    const spot = client.playback.playerView().itemProgressMs;
    await until(() => raop.sessions.every((s) => s.closedAtMs !== null));
    const before = raop.sessions.length;
    await client.own('/player/play', 'PUT');
    await until(() =>
      raop.sessions.slice(before).some((s) => s.audioPayloads.length >= 8)
    );
    assert(client.decodedStart() >= spot);
  } finally {
    await client?.close();
    await raop.close();
    await Deno.remove(dir, { recursive: true });
  }
});
