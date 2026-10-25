import { cp } from 'node:fs/promises';
import { apiFixture } from './api.ts';
import { appLogger, createLogger, installLogger } from '../../src/logging.ts';
import { createScan } from '../../src/scan.ts';
import { createLibraries } from '../../src/libraries.ts';
import { createMedia } from '../../src/media.ts';

export async function statusFixture(lifecycle = false, traceRequests = false) {
  const previous = appLogger();
  const lines: string[] = [];
  let failSink = false;
  const sink = (line: string) => {
    if (failSink) throw new Error('fixture sink');
    lines.push(line);
  };
  const logger = createLogger({ sinks: { stdout: sink, stderr: sink } });
  installLogger(logger);
  const dir = await Deno.makeTempDir({ prefix: 'melofon-status-' });
  const root = `${dir}/layers`;
  let release = () => {};
  let held: Promise<void> | undefined;
  let failMedia = false;
  let scan!: ReturnType<typeof createScan>;
  try {
    if (lifecycle) {
      await cp('layers', root, { recursive: true });
      await Deno.mkdir(`${root}/bad`, { recursive: true });
      await Deno.writeTextFile(`${root}/bad/manifest.json`, '{bad');
    }
    const f = await apiFixture({
      status: logger,
      traceRequests,
      ...(lifecycle
        ? {
          hats: {
            layersRoot: root,
            extraPorts: 2,
            env: (ports: number[]) => ({
              MELOFON_LISTEN_owntone: ports.join(','),
            }),
          },
        }
        : {}),
      services(f) {
        const media = createMedia(undefined, f.state);
        scan = createScan(f.store, {
          ...media,
          async describeAudio(path) {
            await held;
            if (failMedia) throw new Error('fixture scan failure');
            return media.describeAudio(path);
          },
        }, { state: f.state, notify: f.notify });
        return Promise.resolve({
          scan,
          libraries: createLibraries(f.store, {
            dataDir: f.dir,
            scan,
            notify: f.notify,
          }),
        });
      },
    });
    return {
      ...f,
      root,
      dir,
      ownPorts: f.extraPorts,
      logger,
      lines,
      scan,
      failSink(value: boolean) {
        failSink = value;
      },
      failMedia(value: boolean) {
        failMedia = value;
      },
      hold() {
        held = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      release() {
        release();
        held = undefined;
      },
      async close() {
        release();
        await scan.start({ ifRunning: true });
        await f.close();
        installLogger(previous);
        await Deno.remove(dir, { recursive: true });
      },
    };
  } catch (error) {
    installLogger(previous);
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}
