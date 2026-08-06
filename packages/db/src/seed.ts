// Seed script: generate players with a realistic (roughly normal) rating distribution so matchmaking and
// the leaderboard have lifelike data to work against. Idempotent — re-running skips usernames that already
// exist. Run with `pnpm --filter @chess/db db:seed` (honours DATABASE_URL and SEED_COUNT). Hand-written.
import { pathToFileURL } from 'node:url';
import { createDb, type Database } from './client.js';
import { players } from './schema.js';

const MEAN_RATING = 1500;
const RATING_SD = 300;
const MIN_RATING = 400;
const MAX_RATING = 2800;

/** A generated seed player. Structurally a subset of `NewPlayer`, so it inserts directly. */
export interface SeedPlayer {
  username: string;
  rating: number;
}

/** One standard-normal sample via the Box–Muller transform. */
function standardNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generate `count` players with sequential usernames (`player_000000`…) and ratings drawn from a normal
 * distribution centred on 1500, clamped to a sane band. `startIndex` lets callers extend an existing set.
 */
export function makePlayers(count: number, startIndex = 0): SeedPlayer[] {
  return Array.from({ length: count }, (_, i) => {
    const rating = Math.round(MEAN_RATING + RATING_SD * standardNormal());
    return {
      username: `player_${String(startIndex + i).padStart(6, '0')}`,
      rating: Math.max(MIN_RATING, Math.min(MAX_RATING, rating)),
    };
  });
}

/** Insert `count` seed players in chunks, skipping any whose username already exists. */
export async function seedPlayers(db: Database, count: number, chunkSize = 1000): Promise<number> {
  const rows = makePlayers(count);
  for (let i = 0; i < rows.length; i += chunkSize) {
    await db
      .insert(players)
      .values(rows.slice(i, i + chunkSize))
      .onConflictDoNothing();
  }
  return rows.length;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://chess:chess@localhost:5432/chess';
  const count = Number(process.env.SEED_COUNT ?? 10_000);
  const handle = createDb(url);
  try {
    const n = await seedPlayers(handle.db, count);
    console.log(`seeded ${n} players into ${url}`);
  } finally {
    await handle.close();
  }
}

// Run only when executed directly (tsx src/seed.ts), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
