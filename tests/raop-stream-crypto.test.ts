import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import type { FakeRaopSession } from './helpers/fake-raop.ts';
import {
  libraryProof,
  nativeStream,
  pcm,
  rendered,
  startFakeRaop,
  until,
} from './helpers/raop-isolation.ts';

for (const mode of ['dormant', 'concurrent', 'concurrent B plaintext']) {
  const concurrent = mode !== 'dormant';
  const encryptedB = mode !== 'concurrent B plaintext';
  const name =
    `RAOP crypto: ${mode} keys survive foreign retirement with exact AES, OAEP, SDP and mixed-master PCM`;
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      if (!Deno.env.get('RAOP_CRYPTO_OBSERVER')) {
        const directory = await Deno.makeTempDir({ prefix: 'raop-crypto-' });
        const path = `${directory}/crypto.so`;
        const build = await new Deno.Command('cc', {
          args: [
            '-shared',
            '-fPIC',
            '-Wall',
            '-o',
            path,
            new URL('../helper/raop/test/crypto-observer.c', import.meta.url)
              .pathname,
            '-lgcrypt',
            '-ldl',
            '-lpthread',
          ],
        }).output();
        assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
        const child = await new Deno.Command(Deno.execPath(), {
          args: [
            'test',
            '--frozen',
            '--cached-only',
            '--node-modules-dir=manual',
            '-A',
            '--filter',
            name,
            new URL(import.meta.url).pathname,
          ],
          env: { LD_PRELOAD: path, RAOP_CRYPTO_OBSERVER: path },
        }).output();
        await Deno.writeFile(`${directory}/child.stdout`, child.stdout);
        await Deno.writeFile(`${directory}/child.stderr`, child.stderr);
        const stdout = new TextDecoder().decode(child.stdout);
        assertEquals(
          child.code,
          0,
          stdout + new TextDecoder().decode(child.stderr),
        );
        assert(/1 passed.*0 failed/.test(stdout));
        for (const line of stdout.split('\n')) {
          if (line.startsWith('isolation native library:')) console.log(line);
        }
        return;
      }
      const observer = Deno.dlopen(Deno.env.get('RAOP_CRYPTO_OBSERVER')!, {
        raop_crypto_generated: { parameters: [], result: 'u32' },
        raop_crypto_live: { parameters: [], result: 'u32' },
        raop_crypto_sdp: { parameters: ['buffer', 'buffer'], result: 'i32' },
        raop_crypto_decrypt: {
          parameters: ['u32', 'buffer', 'usize', 'buffer'],
          result: 'i32',
        },
      });
      const probe = observer.symbols;
      function decrypt(session: FakeRaopSession) {
        const rsa = decodeBase64(/^a=rsaaeskey:(.+)\r$/m.exec(session.sdp)![1]);
        const iv = decodeBase64(/^a=aesiv:(.+)\r$/m.exec(session.sdp)![1]);
        const padded = new Uint8Array(256);
        padded.set(rsa, 256 - rsa.length);
        const index = probe.raop_crypto_sdp(padded, iv);
        assert(
          index >= 0,
          'SDP RSA output/IV must match observed AES and decoded OAEP key input',
        );
        const plain = (bytes: Uint8Array) => {
          const output = new Uint8Array(bytes.length);
          assertEquals(
            probe.raop_crypto_decrypt(
              index,
              bytes,
              BigInt(bytes.length),
              output,
            ),
            0,
          );
          assertNotEquals(
            output,
            bytes,
            'actual encrypted ALAC must differ from plaintext',
          );
          return output;
        };
        const result: FakeRaopSession = {
          ...session,
          sdp: session.sdp.replace(/^a=(?:rsaaeskey|aesiv):.+\r\n/gm, ''),
          audioPayloads: session.audioPayloads.map(plain),
          wire: session.wire.map((event) => {
            if (event.kind !== 'audio') return event;
            const data = event.data.slice();
            data.set(plain(data.subarray(12)), 12);
            return { ...event, data };
          }),
        };
        return { index, session: result };
      }
      const a = nativeStream(), b = nativeStream();
      const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
      const plain = await startFakeRaop({
        captureAudio: true,
        captureWire: true,
      });
      const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
      try {
        // Seed B before any receiver or PCM; A must never replace B's key/IV.
        assertEquals(await b.metadata('Dormant encrypted B', 'B', 0, 2000), 0);
        assertEquals(
          await a.metadata('Encrypted and plaintext A', 'A', 0, 1000),
          0,
        );
        assertEquals(
          [probe.raop_crypto_generated(), probe.raop_crypto_live()],
          [
            2,
            2,
          ],
        );
        await a.attach(ra, 5, true);
        await a.attach(plain, 5, false);
        if (concurrent) {
          await b.attach(rb, 5, encryptedB);
          b.write(pcm(704, 920));
          await until(
            'concurrent B encrypted packets',
            () => rb.sessions[0].audioPackets === 2,
          );
        }
        a.write(pcm(704, 41));
        await until(
          'encrypted A packets',
          () => ra.sessions[0].audioPackets === 2,
        );
        let da!: ReturnType<typeof decrypt>;
        await Promise.all([
          rendered(
            ra,
            pcm(704, 41),
            (session) => (da = decrypt(session)).session,
          ),
          rendered(plain, pcm(704, 41)),
        ]);
        assertEquals(plain.sessions[0].sdp.includes('a=rsaaeskey:'), false);
        assertEquals(await a.metadata('A replacement', 'A2', 0, 3000), 0);
        await a.close();
        assertEquals(
          [probe.raop_crypto_generated(), probe.raop_crypto_live()],
          [
            2,
            1,
          ],
        );
        if (!concurrent) await b.attach(rb, 5, true);
        if (!concurrent) b.write(pcm(704, 920));
        await until(
          'encrypted B packets',
          () => rb.sessions[0].audioPackets === 2,
        );
        let db!: ReturnType<typeof decrypt>;
        await rendered(rb, pcm(704, 920), (session) => {
          db = encryptedB ? decrypt(session) : { index: -1, session };
          return db.session;
        });
        assertEquals(rb.sessions[0].sdp.includes('a=rsaaeskey:'), encryptedB);
        assertNotEquals(
          da.index,
          db.index,
          'different streams cannot share cipher state',
        );
        assertEquals(
          [probe.raop_crypto_generated(), probe.raop_crypto_live()],
          [
            2,
            1,
          ],
        );
        await libraryProof();
        await b.close();
        assertEquals(
          probe.raop_crypto_live(),
          0,
          'last stream releases and erases test key copies',
        );
      } finally {
        await a.close();
        await b.close();
        ra.close();
        plain.close();
        rb.close();
        observer.close();
      }
    },
  });
}
