// main.ts — load config, open DB, seed the first-boot user, boot the core
// tree + glob layers, serve the facade on the process default listen.
import { pathfinder } from '@pathfinder/pathfinder';
import { loadConfig } from './src/config.ts';
import { openDb } from './src/db.ts';
import { seedFirstUser } from './src/users.ts';
import { loadLayers } from './src/layers.ts';
import { facade } from './src/facade.ts';

const cfg = loadConfig();
const db = await openDb(cfg.dataDir);
await seedFirstUser(db, cfg);
const app = { db, cfg };
const core = await pathfinder({ roots: ['core/'], app });
const layers = await loadLayers({ db, cfg });
Deno.serve(cfg.listen ?? {}, facade(core, layers));
