import { assert, assertEquals, assertRejects } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { Decoder, Demuxer } from 'node-av';
import { createListenManager } from '../src/listen-manager.ts';
import { createPortMapping } from '../src/binds.ts';
import { createMedia } from '../src/media.ts';
import { createNetwork } from '../src/lookups/net.ts';
import { pinnedRequest } from '../src/net-transport.ts';
import { reservePorts } from './helpers/ports.ts';

for (const mode of ['rollback', 'shutdown'] as const) {
  Deno.test(`listeners retain failed handles and settle all siblings during ${mode}`, async () => {
    using ports = reservePorts(3);
    const [a, b, unavailable] = ports.ports;
    const original = Deno.serve;
    let finish!: () => void;
    const held = new Promise<void>((resolve) => finish = resolve);
    let refuse = true;
    let siblingReleased = false;
    const handles: Deno.HttpServer<Deno.NetAddr>[] = [];
    Deno.serve =
      ((options: Deno.ServeTcpOptions, handler: Deno.ServeHandler) => {
        if (options.port === unavailable) throw new Error('bind failed');
        const server = original(options, handler);
        handles.push(server);
        const shutdown = server.shutdown.bind(server);
        server.shutdown = async () => {
          if (options.port === a && refuse) throw new Error('close failed');
          if (options.port === b) await held;
          await shutdown();
          if (options.port === b) siblingReleased = true;
        };
        return server;
      }) as typeof Deno.serve;
    const core = await pathfinder({ roots: ['core/'], app: {} });
    const manager = createListenManager({
      core,
      layers: () => [],
      mapping: createPortMapping({}),
      defaultPort: a,
      hostname: '0.0.0.0',
    });
    try {
      ports.release();
      if (mode === 'shutdown') await manager.ensure([a, b]);
      let settled = false;
      const attempt = mode === 'rollback'
        ? manager.ensure([a, b, unavailable])
        : manager.shutdown();
      if (mode === 'shutdown') assertEquals(manager.shutdown(), attempt);
      const closing = attempt.finally(() => settled = true);
      const rejected = assertRejects(() => closing, AggregateError);
      // Wait for an observable opened listener, not a timing assumption.
      while (handles.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      assertEquals(settled, false);
      finish();
      await rejected;
      assertEquals(siblingReleased, true);
      assertEquals(manager.list().map((row) => row.port), [a]);
      if (mode === 'rollback') {
        await assertRejects(() => manager.ensure([a]), Error, 'awaits release');
      }
      const live = await fetch(`http://melofon.home:${a}/`);
      await live.body?.cancel();
      refuse = false;
      await manager.shutdown();
      assertEquals(manager.list(), []);
      const rebound = Deno.listen({ hostname: '0.0.0.0', port: a });
      rebound.close();
    } finally {
      finish();
      refuse = false;
      await manager.shutdown();
      await Promise.allSettled(handles.map((handle) => handle.shutdown()));
      Deno.serve = original;
    }
  });
}

for (const kind of ['file', 'input'] as const) {
  Deno.test(`PCM ${kind} releases its input after decoder disposal fails`, async () => {
    const dispose = Decoder.prototype[Symbol.dispose];
    const inputClose = Demuxer.prototype.close;
    let inputReleased = 0;
    let sourceReleased = 0;
    Decoder.prototype[Symbol.dispose] = function () {
      dispose.call(this);
      throw new Error('decoder disposal failed');
    };
    Demuxer.prototype.close = async function () {
      await inputClose.call(this);
      inputReleased++;
    };
    try {
      const path = 'tests/fixtures/media/clip.flac';
      const media = createMedia();
      const source = new Blob([await Deno.readFile(path)]).stream();
      const pcm = kind === 'file'
        ? await media.decodePcm(path)
        : await media.decodeInputPcm({
          body: source,
          close: () => {
            sourceReleased++;
            return Promise.resolve();
          },
        });
      assert(pcm);
      const failure = await assertRejects(() =>
        pcm[Symbol.asyncIterator]().return!()
      );
      assertEquals(inputReleased, 1);
      assert(failure instanceof AggregateError);
      assertEquals(sourceReleased, kind === 'input' ? 1 : 0);
      assertEquals(source.locked, false);
    } finally {
      Decoder.prototype[Symbol.dispose] = dispose;
      Demuxer.prototype.close = inputClose;
    }
  });
}

Deno.test('PCM acquisition rollback reports source failure and still closes the acquired input', async () => {
  const create = Decoder.create;
  const close = Demuxer.prototype.close;
  let released = 0;
  Decoder.create = () =>
    Promise.reject(new Error('decoder acquisition failed'));
  Demuxer.prototype.close = async function () {
    await close.call(this);
    released++;
  };
  try {
    const bytes = await Deno.readFile('tests/fixtures/media/clip.flac');
    const body = new Blob([bytes]).stream();
    const failure = await assertRejects(
      () =>
        createMedia().decodeInputPcm({
          body,
          close: () => Promise.reject(new Error('source release failed')),
        }),
      AggregateError,
      'PCM acquisition rollback failed',
    );
    assertEquals(failure.errors[0].message, 'decoder acquisition failed');
    assertEquals(failure.errors[1].message, 'Release failed: source');
    assertEquals(body.locked, false);
    assertEquals(released, 1);
  } finally {
    Decoder.create = create;
    Demuxer.prototype.close = close;
  }
});

Deno.test('network transfer closes the transport when partial file removal fails', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'release-network-' });
  const listening = Deno.listen({ hostname: '0.0.0.0', port: 0 });
  const port = listening.addr.port;
  const closed = (async () => {
    const conn = await listening.accept();
    try {
      const bytes = new Uint8Array(4096);
      await conn.read(bytes);
      await conn.write(new TextEncoder().encode(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n12345678\r\n0\r\n\r\n',
      ));
      while (await conn.read(bytes) !== null) {
        /* wait for consumer release */
      }
    } finally {
      conn.close();
    }
  })();
  const remove = Deno.remove;
  let transportReleased = false;
  Deno.remove = ((path: string | URL, options?: Deno.RemoveOptions) => {
    if (String(path).endsWith('.part')) {
      return Promise.reject(new Error('unlink failed'));
    }
    return remove(path, options);
  }) as typeof Deno.remove;
  try {
    const network = createNetwork({
      request: async (...args) => {
        const transport = await pinnedRequest(...args);
        return {
          response: transport.response,
          async close() {
            await transport.close();
            transportReleased = true;
          },
        };
      },
    });
    // Size refusal leaves the partial file owned by the attempt.
    await assertRejects(
      () =>
        network.toFile(
          {
            caller: 'release-test',
            hosts: () => true,
            trustedHosts: ['melofon.home'],
            ratePerMinute: 60000,
            signal: new AbortController().signal,
          },
          `http://melofon.home:${port}/`,
          `${dir}/download`,
          {
            maxBytes: 4,
            timeoutMs: 2000,
          },
        ),
      AggregateError,
      'Network transfer release failed',
    );
    assertEquals(transportReleased, true);
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        // Cleared below by the signal-based helper instead of leaking a timer.
        const signal = AbortSignal.timeout(2000);
        signal.addEventListener(
          'abort',
          () => reject(new Error('transport still open')),
          { once: true },
        );
      }),
    ]);
  } finally {
    Deno.remove = remove;
    listening.close();
    await remove(dir, { recursive: true });
  }
});
