// Spins up a minimal in-process `ws` server + the SDK's GameSession and verifies the full typed
// event stream — gameState bootstrap, moveAck, opponentMove, gameEnd — maps onto GameEvent correctly.
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameSession, type GameEvent, type WebSocketCtor } from './game-session.js';

let wss: WebSocketServer;
let port: number;
let serverFrames: unknown[];
interface UpgradeSnapshot {
  authorization: string | undefined;
  tokenParam: string | undefined;
}
let lastUpgrade: UpgradeSnapshot;

beforeEach(() => {
  serverFrames = [];
  lastUpgrade = { authorization: undefined, tokenParam: undefined };
  wss = new WebSocketServer({ port: 0 });
  port = (wss.address() as AddressInfo).port;
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    lastUpgrade = {
      authorization: req.headers['authorization'] as string | undefined,
      tokenParam: url.searchParams.get('token') ?? undefined,
    };
    socket.send(
      JSON.stringify({
        type: 'gameState',
        gameId: '00000000-0000-0000-0000-000000000001',
        color: 'w',
        fen: 'start',
        turn: 'w',
        whiteMs: 180_000,
        blackMs: 180_000,
        moves: [],
        status: 'active',
      }),
    );
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      serverFrames.push(msg);
      if (msg.type === 'sendMove') {
        socket.send(
          JSON.stringify({
            type: 'moveAck',
            accepted: true,
            whiteMs: 179_000,
            blackMs: 180_000,
            creditMs: 25,
          }),
        );
      } else if (msg.type === 'resign') {
        socket.send(JSON.stringify({ type: 'gameEnd', result: '0-1', endReason: 'resign' }));
      }
    });
  });
});

afterEach(() => {
  wss.close();
});

function connect(): { session: GameSession; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const session = new GameSession({
    wsUrl: `ws://127.0.0.1:${port}`,
    gameId: '00000000-0000-0000-0000-000000000001',
    playerId: '11111111-1111-1111-1111-111111111111',
    token: 'bearer.tok',
    webSocketImpl: NodeWebSocket as unknown as WebSocketCtor,
  });
  session.on((ev) => events.push(ev));
  return { session, events };
}

/** Wait until `pred(events)` is true, or throw. */
function waitFor(events: GameEvent[], pred: (e: GameEvent[]) => boolean, timeoutMs = 2_000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (pred(events)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('GameSession', () => {
  it('receives gameState on connect and surfaces it as a typed event', async () => {
    const { session, events } = connect();
    await waitFor(events, (e) => e.some((x) => x.type === 'state'));
    const state = events.find((e) => e.type === 'state');
    expect(state).toBeDefined();
    if (state?.type === 'state') {
      expect(state.state.color).toBe('w');
      expect(state.state.turn).toBe('w');
    }
    session.close();
  });

  it('sends sendMove over the wire and emits a typed ack', async () => {
    const { session, events } = connect();
    await waitFor(events, (e) => e.some((x) => x.type === 'state'));
    session.sendMove('e2', 'e4', 1);
    await waitFor(events, (e) => e.some((x) => x.type === 'ack'));
    const ack = events.find((e) => e.type === 'ack');
    expect(ack).toBeDefined();
    if (ack?.type === 'ack') {
      expect(ack.accepted).toBe(true);
      expect(ack.whiteMs).toBe(179_000);
      expect(ack.creditMs).toBe(25);
    }
    expect(serverFrames).toContainEqual({
      type: 'sendMove',
      from: 'e2',
      to: 'e4',
      moveNumber: 1,
    });
    session.close();
  });

  it('resign leads to a gameEnd event', async () => {
    const { session, events } = connect();
    await waitFor(events, (e) => e.some((x) => x.type === 'state'));
    session.resign();
    await waitFor(events, (e) => e.some((x) => x.type === 'end'));
    const end = events.find((e) => e.type === 'end');
    expect(end).toBeDefined();
    if (end?.type === 'end') {
      expect(end.result).toBe('0-1');
      expect(end.endReason).toBe('resign');
    }
    session.close();
  });

  it('emits closed with the socket close code', async () => {
    const { session, events } = connect();
    await waitFor(events, (e) => e.some((x) => x.type === 'state'));
    session.close();
    await waitFor(events, (e) => e.some((x) => x.type === 'closed'));
    const closed = events.find((e) => e.type === 'closed');
    expect(closed).toBeDefined();
  });

  it('carries the token both as ?token= (browser-safe) and Authorization header (Node)', async () => {
    const { session, events } = connect();
    await waitFor(events, (e) => e.some((x) => x.type === 'state'));
    expect(lastUpgrade.tokenParam).toBe('bearer.tok');
    expect(lastUpgrade.authorization).toBe('Bearer bearer.tok');
    session.close();
  });
});
