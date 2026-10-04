// Full rebuild path: drops the leaderboard sorted set and reloads it from the authoritative players
// table in Postgres. Used manually when drift is suspected; also safe to run at startup.
import { asc, gt } from 'drizzle-orm';
import type Redis from 'ioredis';
import { players, type Database } from '@chess/db';
import { LEADERBOARD_KEY } from './keys.js';

export interface ReconcileResult {
  totalPlayers: number;
  loadedIntoRedis: number;
}

export async function reconcile(
  db: Database,
  redis: Redis,
  chunkSize = 1000,
): Promise<ReconcileResult> {
  // Drop first; the ZADD stream below rebuilds everything in sorted-set order.
  await redis.del(LEADERBOARD_KEY);

  let loaded = 0;
  let cursor = '';
  // Keyset scan on username (unique + indexed via unique) — cheap, order-stable, no OFFSET.
  while (true) {
    const page = await db
      .select({ id: players.playerId, rating: players.rating, username: players.username })
      .from(players)
      .where(cursor ? gt(players.username, cursor) : undefined)
      .orderBy(asc(players.username))
      .limit(chunkSize);
    if (page.length === 0) break;

    const args: Array<string | number> = [];
    for (const row of page) {
      args.push(row.rating, row.id);
    }
    await redis.zadd(LEADERBOARD_KEY, ...(args as [string | number, ...Array<string | number>]));
    loaded += page.length;

    const tail = page[page.length - 1];
    if (!tail) break;
    cursor = tail.username;
    if (page.length < chunkSize) break;
  }

  return { totalPlayers: loaded, loadedIntoRedis: loaded };
}
