// Integration tests against a real Postgres via Testcontainers. Proves migrations apply, the schema is
// usable, and — the important invariant — the generation guard rejects a stale (zombie) write. Requires a
// running Docker daemon; the container is started once for the whole file.
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import {
  appendMove,
  createGame,
  getGame,
  getMoves,
  insertPlayer,
  takeOwnership,
} from './repositories.js';
import type { Game } from './schema.js';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle.db);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

/** Seed two fresh players and an active game between them. */
async function seedGame(): Promise<Game> {
  const white = await insertPlayer(handle.db, { username: `w-${randomUUID()}` });
  const black = await insertPlayer(handle.db, { username: `b-${randomUUID()}` });
  return createGame(handle.db, {
    whiteId: white.playerId,
    blackId: black.playerId,
    timeControl: 'blitz-3-2',
    whiteMs: 180_000,
    blackMs: 180_000,
    turn: 'w',
    whiteRatingStart: white.rating,
    blackRatingStart: black.rating,
  });
}

describe('migrations + schema', () => {
  it('apply cleanly; a new game starts active at generation 0', async () => {
    const game = await seedGame();
    expect(game.status).toBe('active');
    expect(game.generation).toBe(0);
    expect(game.whiteMs).toBe(180_000);
  });
});

describe('appendMove — generation-guarded write', () => {
  it('appends the move and updates clocks + turn at the expected generation', async () => {
    const game = await seedGame();
    const applied = await appendMove(handle.db, {
      gameId: game.gameId,
      expectedGeneration: 0,
      move: { moveNumber: 1, ply: 0, san: 'e4', uci: 'e2e4', clockMs: 179_000 },
      whiteMs: 179_000,
      blackMs: 180_000,
      turn: 'b',
    });
    expect(applied).toBe(true);

    const log = await getMoves(handle.db, game.gameId);
    expect(log.map((m) => m.uci)).toEqual(['e2e4']);

    const after = await getGame(handle.db, game.gameId);
    expect(after?.turn).toBe('b');
    expect(after?.whiteMs).toBe(179_000);
  });

  it('rejects a stale-generation (zombie) write and mutates nothing', async () => {
    const game = await seedGame();

    // A replacement server takes over → generation becomes 1.
    const owned = await takeOwnership(handle.db, game.gameId);
    expect(owned?.generation).toBe(1);

    // The old owner (zombie) still believes it holds generation 0.
    const applied = await appendMove(handle.db, {
      gameId: game.gameId,
      expectedGeneration: 0,
      move: { moveNumber: 1, ply: 0, san: 'e4', uci: 'e2e4', clockMs: 179_000 },
      whiteMs: 179_000,
      blackMs: 180_000,
      turn: 'b',
    });

    expect(applied).toBe(false);
    expect(await getMoves(handle.db, game.gameId)).toHaveLength(0);
    const after = await getGame(handle.db, game.gameId);
    expect(after?.whiteMs).toBe(180_000); // unchanged
    expect(after?.turn).toBe('w'); // unchanged
  });

  it('keeps the move log ordered by ply for replay', async () => {
    const game = await seedGame();
    const seq = ['e2e4', 'e7e5', 'g1f3'];
    for (const [i, uci] of seq.entries()) {
      const applied = await appendMove(handle.db, {
        gameId: game.gameId,
        expectedGeneration: 0,
        move: { moveNumber: Math.floor(i / 2) + 1, ply: i, san: uci, uci, clockMs: 180_000 },
        whiteMs: 180_000,
        blackMs: 180_000,
        turn: i % 2 === 0 ? 'b' : 'w',
      });
      expect(applied).toBe(true);
    }
    const log = await getMoves(handle.db, game.gameId);
    expect(log.map((m) => m.ply)).toEqual([0, 1, 2]);
    expect(log.map((m) => m.uci)).toEqual(seq);
  });
});
