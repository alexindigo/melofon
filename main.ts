// Dependency-light entrypoint: redaction and adapters precede application evaluation.
import { appLogger } from './src/logging.ts';
import { installDependencyLogging } from './src/logging-dependencies.ts';

const log = appLogger();
log.registerSecrets(
  ['MELOFON_PASSWORD', 'MELOFON_SECRET'].map((key) => Deno.env.get(key)),
);
try {
  installDependencyLogging(log);
  const { startServer } = await import('./src/server.ts');
  await startServer();
} catch (error) {
  log.event('startup_failed', { error });
  await log.flush();
  Deno.exit(1);
}
