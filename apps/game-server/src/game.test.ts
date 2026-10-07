// End-to-end game-server integration: real Postgres, real WS server on an ephemeral port, two WebSocket
// clients that play a short mate. Covers the handshake, persist-before-broadcast, out-of-turn rejection,
// resign, and 403 for a non-player.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDb,
  createGame,
  getGame,
  getMoves,
  insertPlayer,
  runMigrations,
  takeOwnership,
  type DbHandle,
} from '@chess/db';
import type { ServerMessage } from '@chess/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier } from './auth.js';
import { SessionManager } from './sessions.js';
import { WsHub } from './ws.js';

const JWT_SECRET = 'test-secret-16-chars-min';
const tokenFor = (playerId: string): string =>
  jwt.sign({ sub: playerId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

let pg: StartedPostgreSqlContainer;
let db: DbHandle;
let app: FastifyInstance;
let hub: WsHub;
let baseUrl: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = createDb(pg.getConnectionUri());
  await runMigrations(db.db);
  const sessions = new SessionManager(db.db);
  hub = new WsHub({ db: db.db, sessions, verifyToken: createTokenVerifier(JWT_SECRET) });

  app = Fastify({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  hub.attach(app.server);
  const addr = app.server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${addr.port}`;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pg?.stop();
});

/** WS client wrapper with an internal queue so messages that arrive before `next()` is called aren't lost. */
interface Client {
  ws: WebSocket;
  next: (timeoutMs?: number) => Promise<ServerMessage>;
  send: (msg: unknown) => void;
  close: () => void;
}

async function connect(gameId: string, playerId: string): Promise<Client> {
  const ws = new WebSocket(`${baseUrl}/ws/games/${gameId}`, {
    headers: { authorization: `Bearer ${tokenFor(playerId)}` },
  });
  const queue: ServerMessage[] = [];
  const waiters: Array<(msg: ServerMessage) => void> = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    next(timeoutMs = 2_000) {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

interface SeedOpts {
  whiteMs?: number;
  blackMs?: number;
}

async function seedGame(opts: SeedOpts = {}) {
  const white = await insertPlayer(db.db, { username: `w-${randomUUID()}`, rating: 1500 });
  const black = await insertPlayer(db.db, { username: `b-${randomUUID()}`, rating: 1500 });
  const game = await createGame(db.db, {
    whiteId: white.playerId,
    blackId: black.playerId,
    timeControl: 'blitz-3-2',
    whiteMs: opts.whiteMs ?? 180_000,
    blackMs: opts.blackMs ?? 180_000,
    turn: 'w',
    whiteRatingStart: white.rating,
    blackRatingStart: black.rating,
  });
  return { white, black, game };
}

describe('game-server WS', () => {
  it('plays fool’s mate end to end — persist, broadcast, finish', async () => {
    const { white, black, game } = await seedGame();

    const w = await connect(game.gameId, white.playerId);
    const stateW = await w.next();
    expect(stateW.type).toBe('gameState');
    if (stateW.type === 'gameState') {
      expect(stateW.color).toBe('w');
      expect(stateW.turn).toBe('w');
    }

    const b = await connect(game.gameId, black.playerId);
    const stateB = await b.next();
    if (stateB.type === 'gameState') expect(stateB.color).toBe('b');

    // 1. f3
    w.send({ type: 'sendMove', from: 'f2', to: 'f3', moveNumber: 1 });
    const ackW1 = await w.next();
    expect(ackW1.type).toBe('moveAck');
    if (ackW1.type === 'moveAck') expect(ackW1.accepted).toBe(true);
    const oppB1 = await b.next();
    if (oppB1.type === 'opponentMove') expect(oppB1.san).toBe('f3');

    // 1... e5
    b.send({ type: 'sendMove', from: 'e7', to: 'e5', moveNumber: 1 });
    await b.next();
    await w.next();

    // 2. g4
    w.send({ type: 'sendMove', from: 'g2', to: 'g4', moveNumber: 2 });
    await w.next();
    await b.next();

    // 2... Qh4#  — fool's mate
    b.send({ type: 'sendMove', from: 'd8', to: 'h4', moveNumber: 2 });
    const ackB = await b.next();
    expect(ackB.type).toBe('moveAck');
    const oppW = await w.next();
    expect(oppW.type).toBe('opponentMove');

    const endB = await b.next();
    const endW = await w.next();
    expect(endB.type).toBe('gameEnd');
    expect(endW.type).toBe('gameEnd');
    if (endB.type === 'gameEnd') {
      expect(endB.result).toBe('0-1');
      expect(endB.endReason).toBe('checkmate');
    }

    const after = await getGame(db.db, game.gameId);
    expect(after?.status).toBe('finished');
    expect(after?.result).toBe('0-1');
    const log = await getMoves(db.db, game.gameId);
    expect(log.map((m) => m.uci)).toEqual(['f2f3', 'e7e5', 'g2g4', 'd8h4']);

    w.close();
    b.close();
  });

  it('rejects a move from the side that is not on turn', async () => {
    const { white, black, game } = await seedGame();
    const w = await connect(game.gameId, white.playerId);
    await w.next(); // gameState
    const b = await connect(game.gameId, black.playerId);
    await b.next();

    b.send({ type: 'sendMove', from: 'e7', to: 'e5', moveNumber: 1 });
    const ack = await b.next();
    expect(ack.type).toBe('moveAck');
    if (ack.type === 'moveAck') {
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('not_your_turn');
    }

    const log = await getMoves(db.db, game.gameId);
    expect(log).toHaveLength(0);
    w.close();
    b.close();
  });

  it('rejects a WS upgrade from a non-player (403)', async () => {
    const { game } = await seedGame();
    const stranger = randomUUID();
    const ws = new WebSocket(`${baseUrl}/ws/games/${game.gameId}`, {
      headers: { authorization: `Bearer ${tokenFor(stranger)}` },
    });
    const code = await new Promise<number | undefined>((resolve, reject) => {
      ws.once('error', () => resolve(undefined));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('open', () => reject(new Error('unexpected open')));
    });
    expect(code).toBe(403);
  });

  it('rejects an upgrade with no token (401)', async () => {
    const { game } = await seedGame();
    const ws = new WebSocket(`${baseUrl}/ws/games/${game.gameId}`);
    const code = await new Promise<number | undefined>((resolve, reject) => {
      ws.once('error', () => resolve(undefined));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('open', () => reject(new Error('unexpected open')));
    });
    expect(code).toBe(401);
  });

  it('rejects an upgrade signed with the wrong secret (401)', async () => {
    const { white, game } = await seedGame();
    const forged = jwt.sign({ sub: white.playerId }, 'other-secret-16-chars', {
      algorithm: 'HS256',
    });
    const ws = new WebSocket(`${baseUrl}/ws/games/${game.gameId}`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    const code = await new Promise<number | undefined>((resolve, reject) => {
      ws.once('error', () => resolve(undefined));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('open', () => reject(new Error('unexpected open')));
    });
    expect(code).toBe(401);
  });

  it('accepts a token passed via ?token= query (browser path)', async () => {
    const { white, game } = await seedGame();
    const ws = new WebSocket(
      `${baseUrl}/ws/games/${game.gameId}?token=${encodeURIComponent(tokenFor(white.playerId))}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    });
    ws.close();
  });

  it('resign ends the game and persists', async () => {
    const { white, black, game } = await seedGame();
    const w = await connect(game.gameId, white.playerId);
    await w.next();
    const b = await connect(game.gameId, black.playerId);
    await b.next();

    w.send({ type: 'resign' });
    const endW = await w.next();
    const endB = await b.next();
    expect(endW.type).toBe('gameEnd');
    expect(endB.type).toBe('gameEnd');
    if (endW.type === 'gameEnd') {
      expect(endW.result).toBe('0-1');
      expect(endW.endReason).toBe('resign');
    }
    const after = await getGame(db.db, game.gameId);
    expect(after?.status).toBe('finished');
  });

  it('flags the mover when their clock runs out without a move', async () => {
    const { white, black, game } = await seedGame({ whiteMs: 300 });
    const w = await connect(game.gameId, white.playerId);
    await w.next(); // gameState
    const b = await connect(game.gameId, black.playerId);
    await b.next();

    // Nobody moves — white's 300ms clock expires, flag timer fires.
    const endW = await w.next(2_000);
    const endB = await b.next(2_000);
    expect(endW.type).toBe('gameEnd');
    expect(endB.type).toBe('gameEnd');
    if (endW.type === 'gameEnd') {
      expect(endW.endReason).toBe('flag');
      expect(endW.result).toBe('0-1'); // white flagged → black wins
    }
    const after = await getGame(db.db, game.gameId);
    expect(after?.status).toBe('finished');
    expect(after?.endReason).toBe('flag');
  });

  it('reconnect: a client that disconnects mid-game sees the full move log on rejoin', async () => {
    const { white, black, game } = await seedGame();
    const w = await connect(game.gameId, white.playerId);
    await w.next();
    const b = await connect(game.gameId, black.playerId);
    await b.next();

    // Play two half-moves: 1. e4 e5
    w.send({ type: 'sendMove', from: 'e2', to: 'e4', moveNumber: 1 });
    await w.next();
    await b.next();
    b.send({ type: 'sendMove', from: 'e7', to: 'e5', moveNumber: 1 });
    await b.next();
    await w.next();

    w.close();

    // Reconnect as white — new gameState should include both moves and the correct turn (w again, since
    // black's move flipped turn back to white).
    const w2 = await connect(game.gameId, white.playerId);
    const state = await w2.next();
    expect(state.type).toBe('gameState');
    if (state.type === 'gameState') {
      expect(state.color).toBe('w');
      expect(state.turn).toBe('w');
      expect(state.moves.map((m) => m.uci)).toEqual(['e2e4', 'e7e5']);
    }
    w2.close();
    b.close();
  });

  it('credits the mover for RTT: moveAck.creditMs is half the median, capped at 100ms', async () => {
    const { white, black, game } = await seedGame();
    const w = await connect(game.gameId, white.playerId);
    await w.next();
    const b = await connect(game.gameId, black.playerId);
    await b.next();

    // Seed a predictable median (60ms) for white — credit should be 30ms.
    for (const sample of [40, 60, 80]) hub.recordRttSample(white.playerId, sample);

    w.send({ type: 'sendMove', from: 'e2', to: 'e4', moveNumber: 1 });
    const ack = await w.next();
    expect(ack.type).toBe('moveAck');
    if (ack.type === 'moveAck') {
      expect(ack.accepted).toBe(true);
      expect(ack.creditMs).toBe(30);
    }

    // A spike client (median 500ms) hits the cap (100ms), not 250ms.
    for (const sample of [500, 500, 500]) hub.recordRttSample(black.playerId, sample);
    await b.next(); // consume white's opponentMove
    b.send({ type: 'sendMove', from: 'e7', to: 'e5', moveNumber: 1 });
    const ackB = await b.next();
    if (ackB.type === 'moveAck') expect(ackB.creditMs).toBe(100);

    w.close();
    b.close();
  });

  it('fencing: a stale-generation write is rejected and the client gets an error', async () => {
    const { white, black, game } = await seedGame();
    const w = await connect(game.gameId, white.playerId);
    await w.next();
    const b = await connect(game.gameId, black.playerId);
    await b.next();

    // Simulate another server taking ownership — bumps the DB's generation past what this session holds.
    await takeOwnership(db.db, game.gameId);

    // White attempts to move; the DB's generation guard will reject the write.
    w.send({ type: 'sendMove', from: 'e2', to: 'e4', moveNumber: 1 });
    // moveAck comes before the DB rejection? No — we persist first, so the next message is `error`.
    const msg = await w.next();
    expect(msg.type).toBe('error');
    if (msg.type === 'error') expect(msg.code).toBe('stale_generation');

    // No move landed in the log.
    const log = await getMoves(db.db, game.gameId);
    expect(log).toHaveLength(0);
    w.close();
    b.close();
  });
});
