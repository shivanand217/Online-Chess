// Generate players with a roughly normal rating distribution so matchmaking and the leaderboard have
// lifelike data. Idempotent — re-running skips usernames that already exist.
// Run with `pnpm --filter @chess/db db:seed` (honours DATABASE_URL and SEED_COUNT).
import { pathToFileURL } from 'node:url';
import { createDb, type Database } from './client.js';
import { hashPassword } from './password.js';
import { players } from './schema.js';

const MEAN_RATING = 1500;
const RATING_SD = 300;
const MIN_RATING = 400;
const MAX_RATING = 2800;

export interface SeedPlayer {
  username: string;
  rating: number;
}

/** Deterministic dev password: every seeded `player_000NNN` logs in with `pw_player_000NNN`. */
export const seedPasswordFor = (username: string): string => `pw_${username}`;

/** Standard-normal sample via Box–Muller. */
function standardNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function makePlayers(count: number, startIndex = 0): SeedPlayer[] {
  return Array.from({ length: count }, (_, i) => {
    const rating = Math.round(MEAN_RATING + RATING_SD * standardNormal());
    return {
      username: `player_${String(startIndex + i).padStart(6, '0')}`,
      rating: Math.max(MIN_RATING, Math.min(MAX_RATING, rating)),
    };
  });
}

export async function seedPlayers(db: Database, count: number, chunkSize = 1000): Promise<number> {
  const rows = makePlayers(count);
  // Hashing is slow by design (~100ms each at cost 10); do it in parallel but one chunk at a time to
  // avoid a 10 000-wide concurrent hash on a laptop.
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const hashed = await Promise.all(
      slice.map(async (r) => ({
        username: r.username,
        rating: r.rating,
        passwordHash: await hashPassword(seedPasswordFor(r.username)),
      })),
    );
    await db.insert(players).values(hashed).onConflictDoNothing();
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

// Only run when executed directly (tsx src/seed.ts), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
