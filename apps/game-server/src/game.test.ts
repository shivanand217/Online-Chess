// End-to-end game-server integration: real Postgres, real WS server on an ephemeral port, two WebSocket
// clients that play a short mate. Covers the handshake, persist-before-broadcast, out-of-turn rejection,
// resign, and 403 for a non-player.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDb,
  createGame,
  getGame,
  getMoves,
  insertPlayer,
  runMigrations,
  type DbHandle,
} from '@chess/db';
import type { ServerMessage } from '@chess/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionManager } from './sessions.js';
import { WsHub } from './ws.js';

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
  hub = new WsHub({ db: db.db, sessions });

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
    headers: { 'x-player-id': playerId },
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

async function seedGame() {
  const white = await insertPlayer(db.db, { username: `w-${randomUUID()}`, rating: 1500 });
  const black = await insertPlayer(db.db, { username: `b-${randomUUID()}`, rating: 1500 });
  const game = await createGame(db.db, {
    whiteId: white.playerId,
    blackId: black.playerId,
    timeControl: 'blitz-3-2',
    whiteMs: 180_000,
    blackMs: 180_000,
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
      headers: { 'x-player-id': stranger },
    });
    const code = await new Promise<number | undefined>((resolve, reject) => {
      ws.once('error', () => resolve(undefined));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('open', () => reject(new Error('unexpected open')));
    });
    expect(code).toBe(403);
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
});
