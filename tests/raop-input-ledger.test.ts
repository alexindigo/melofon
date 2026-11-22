import { assert, assertEquals } from '@std/assert';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

for (const [frames, chunks] of [[1152, 3000], [4608, 400]]) {
  Deno.test({
    name:
      `native input ledger: ${chunks} x ${frames} frames complete and start successor`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const directory = await Deno.makeTempDir({ prefix: 'input-ledger-' });
      const receiver = await startFakeRaop({
        captureAudio: true,
        captureWire: true,
      });
      try {
        const build = await new Deno.Command('cc', {
          args: [
            '-o',
            `${directory}/probe`,
            'helper/raop/test/probe_input_ledger.c',
            '-Lhelper/raop',
            '-lmelofon_raop',
            `-Wl,-rpath,${Deno.cwd()}/helper/raop`,
          ],
        }).output();
        assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
        const child = new Deno.Command(`${directory}/probe`, {
          args: [String(receiver.port), String(frames), String(chunks)],
          stdin: 'piped',
          stdout: 'piped',
          stderr: 'piped',
        }).spawn();
        const ready = Promise.withResolvers<void>();
        let stdout = '', finished = false;
        const stderr = new Response(child.stderr).text();
        const status = child.status.then((value) => {
          finished = true;
          return value;
        });
        const reading = (async () => {
          for await (
            const chunk of child.stdout.pipeThrough(new TextDecoderStream())
          ) {
            stdout += chunk;
            if (stdout.includes('INPUT-LEDGER-READY')) ready.resolve();
          }
          ready.reject(
            new Error(`native probe exited before capture: ${stdout}`),
          );
        })();
        try {
          await ready.promise;
          assertEquals(receiver.sessions.length, 1);
          const session = receiver.sessions[0];
          const replay = renderScheduledAudio(session, receiver.nowMs());
          assertEquals(replay.issues, []);
          assertEquals(replay.discarded, []);
          const real = frames * chunks;
          assert(replay.pcm.length >= (real + 353) * 4);
          const samples = new Int16Array(
            replay.pcm.buffer,
            replay.pcm.byteOffset,
            replay.pcm.length / 2,
          );
          for (let i = 0; i < samples.length; i++) {
            assertEquals(
              samples[i],
              i < real * 2 ? 2000 : i < (real + 353) * 2 ? -3000 : 0,
            );
          }
          assertEquals([session.flushes, session.teardowns], [0, 0]);
        } finally {
          if (!finished) {
            const writer = child.stdin.getWriter();
            try {
              await writer.write(new TextEncoder().encode('captured\n'));
              await writer.close();
            } finally {
              writer.releaseLock();
            }
          }
          const exit = await status;
          await reading;
          assertEquals(exit.code, 0, stdout + await stderr);
          assert(stdout.includes('INPUT-LEDGER-OK'));
          console.log(stdout.trim());
        }
      } finally {
        receiver.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}
