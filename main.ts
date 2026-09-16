// main.ts — load config, open DB, seed the first-boot user, glob layers,
// serve the facade on the process default listen.
import { loadConfig } from './src/config.ts';
import { openDb } from './src/db.ts';
import { seedFirstUser } from './src/users.ts';
import { loadLayers } from './src/layers.ts';
import { facade } from './src/facade.ts';

const cfg = loadConfig();
const db = await openDb(cfg.dataDir);
await seedFirstUser(db, cfg);
const layers = await loadLayers({ db, cfg });
Deno.serve(cfg.listen ?? {}, facade(layers));
