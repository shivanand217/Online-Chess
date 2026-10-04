// Integration tests against real Postgres + Redis via Testcontainers.
// The invariants we care about: apply is idempotent (replay a game-end is a no-op), rank reads reflect
// the sorted set, and reconcile converges Redis back to Postgres truth after we drift it deliberately.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Redis from 'ioredis';
import {
  createDb,
  createGame,
  finishGame,
  getPlayer,
  insertPlayer,
  runMigrations,
  takeOwnership,
  type DbHandle,
} from '@chess/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyRatingForGame } from './apply.js';
import { LEADERBOARD_KEY } from './keys.js';
import { reconcile } from './reconcile.js';
import { registerRoutes } from './routes.js';
import { tick } from './sweeper.js';

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let db: DbHandle;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  db = createDb(pg.getConnectionUri());
  await runMigrations(db.db);
  redis = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
  });
  app = Fastify({ logger: false });
  registerRoutes(app, { db: db.db, redis });
}, 180_000);

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await db?.close();
  await Promise.all([pg?.stop(), redisContainer?.stop()]);
});

afterEach(async () => {
  await redis.flushall();
});

async function finishedGame(
  whiteRating: number,
  blackRating: number,
  result: '1-0' | '0-1' | '1/2-1/2',
): Promise<{ gameId: string; whiteId: string; blackId: string }> {
  const white = await insertPlayer(db.db, {
    username: `w-${randomUUID()}`,
    rating: whiteRating,
  });
  const black = await insertPlayer(db.db, {
    username: `b-${randomUUID()}`,
    rating: blackRating,
  });
  const game = await createGame(db.db, {
    whiteId: white.playerId,
    blackId: black.playerId,
    timeControl: 'blitz-3-2',
    whiteMs: 1_000,
    blackMs: 1_000,
    turn: 'w',
    whiteRatingStart: whiteRating,
    blackRatingStart: blackRating,
  });
  const own = await takeOwnership(db.db, game.gameId);
  await finishGame(db.db, {
    gameId: game.gameId,
    expectedGeneration: own!.generation,
    result,
    endReason: 'checkmate',
  });
  return { gameId: game.gameId, whiteId: white.playerId, blackId: black.playerId };
}

describe('applyRatingForGame — idempotency', () => {
  it('applies deltas once; a replay is a no-op', async () => {
    const { gameId, whiteId, blackId } = await finishedGame(1500, 1500, '1-0');

    const first = await applyRatingForGame(db.db, redis, gameId);
    expect(first).not.toBeNull();
    expect(first?.whiteDelta).toBe(16);
    expect(first?.blackDelta).toBe(-16);

    const second = await applyRatingForGame(db.db, redis, gameId);
    expect(second).toBeNull();

    const w = await getPlayer(db.db, whiteId);
    const b = await getPlayer(db.db, blackId);
    expect(w?.rating).toBe(1516);
    expect(b?.rating).toBe(1484);
    expect(w?.gamesPlayed).toBe(1);
    expect(b?.gamesPlayed).toBe(1);

    // Sorted set reflects the applied ratings.
    expect(await redis.zscore(LEADERBOARD_KEY, whiteId)).toBe('1516');
    expect(await redis.zscore(LEADERBOARD_KEY, blackId)).toBe('1484');
  });

  it('skips an active game — only finished rows are eligible', async () => {
    const white = await insertPlayer(db.db, { username: `w-${randomUUID()}` });
    const black = await insertPlayer(db.db, { username: `b-${randomUUID()}` });
    const game = await createGame(db.db, {
      whiteId: white.playerId,
      blackId: black.playerId,
      timeControl: 'blitz-3-2',
      whiteMs: 1_000,
      blackMs: 1_000,
      turn: 'w',
      whiteRatingStart: white.rating,
      blackRatingStart: black.rating,
    });
    expect(await applyRatingForGame(db.db, redis, game.gameId)).toBeNull();
  });
});

describe('sweeper tick', () => {
  it('drains every pending finished game, exactly once', async () => {
    const games = await Promise.all([
      finishedGame(1500, 1500, '1-0'),
      finishedGame(1500, 1500, '0-1'),
      finishedGame(1500, 1500, '1/2-1/2'),
    ]);

    const firstPass = await tick({ db: db.db, redis });
    const secondPass = await tick({ db: db.db, redis });

    expect(firstPass).toBe(3);
    expect(secondPass).toBe(0);
    for (const g of games) {
      expect(await redis.zscore(LEADERBOARD_KEY, g.whiteId)).not.toBeNull();
      expect(await redis.zscore(LEADERBOARD_KEY, g.blackId)).not.toBeNull();
    }
  });
});

describe('rank reads', () => {
  it('GET /leaderboard returns top-N by rating with ranks', async () => {
    // Three games: give us three distinct ratings in the sorted set.
    const g1 = await finishedGame(1500, 1500, '1-0'); // white 1516, black 1484
    const g2 = await finishedGame(1800, 1800, '1-0'); // white 1816, black 1784
    await tick({ db: db.db, redis });

    const res = await app.inject({ method: 'GET', url: '/leaderboard?limit=4' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ playerId: string; rating: number; rank: number }>;
    };
    expect(body.entries).toHaveLength(4);
    // Highest first.
    expect(body.entries[0]?.rating).toBeGreaterThan(body.entries[3]!.rating);
    expect(body.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(body.entries[0]?.playerId).toBe(g2.whiteId); // 1816
    expect(body.entries[3]?.playerId).toBe(g1.blackId); // 1484
  });

  it('GET /players/:id/rank returns the player’s rank and current rating', async () => {
    const { whiteId } = await finishedGame(1500, 1500, '1-0');
    await finishedGame(1600, 1600, '1-0'); // puts someone above us
    await tick({ db: db.db, redis });

    const res = await app.inject({ method: 'GET', url: `/players/${whiteId}/rank` });
    const body = res.json() as { rank: number; rating: number };
    expect(res.statusCode).toBe(200);
    // Sorted desc: 1616 (g2 white), 1584 (g2 black), 1516 (g1 white), 1484 (g1 black) → rank 3.
    expect(body.rank).toBe(3);
    expect(body.rating).toBe(1516);
  });

  it('GET /players/:id/rank 404s for an unknown player', async () => {
    const res = await app.inject({ method: 'GET', url: `/players/${randomUUID()}/rank` });
    expect(res.statusCode).toBe(404);
  });
});

describe('reconcile', () => {
  it('rebuilds the sorted set from Postgres truth after drift', async () => {
    const { whiteId } = await finishedGame(1500, 1500, '1-0');
    await finishedGame(1600, 1600, '0-1');
    await tick({ db: db.db, redis });

    // Deliberately drift Redis: overwrite one entry with a bogus rating.
    await redis.zadd(LEADERBOARD_KEY, 9999, whiteId);
    expect(await redis.zscore(LEADERBOARD_KEY, whiteId)).toBe('9999');

    const summary = await reconcile(db.db, redis);
    expect(summary.loadedIntoRedis).toBeGreaterThanOrEqual(4);
    const authoritative = await getPlayer(db.db, whiteId);
    // Postgres truth is 1516; Redis now mirrors it.
    expect(await redis.zscore(LEADERBOARD_KEY, whiteId)).toBe(String(authoritative?.rating));
  });
});
