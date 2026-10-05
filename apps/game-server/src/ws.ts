// WebSocket layer. One connection per playerId per game; a second connection from the same player
// replaces the first (prevents orphan sockets after a reconnect). Every mutating message hits Postgres
// via `appendMove` or `finishGame` BEFORE anything is broadcast — the DB is the source of truth, the
// network is just a notification channel.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { IllegalMoveError } from '@chess/chess-engine';
import { appendMove, finishGame, getMoves, type Database } from '@chess/db';
import { ClientMessage, type ServerMessage } from '@chess/protocol';
import { FlagTimers } from './flag-timer.js';
import { liveConnections, moveLatencySeconds, movesTotal, rttCreditMsTotal } from './metrics.js';
import { RttTracker, creditFromMedian } from './rtt-tracker.js';
import type { EndReason, GameSession } from './session.js';
import { TimeExpiredError } from './session.js';
import type { SessionManager } from './sessions.js';
import type { Result } from '@chess/chess-engine';

export interface WsDeps {
  db: Database;
  sessions: SessionManager;
  /** How often to ping each live connection to sample RTT. */
  pingIntervalMs?: number;
  /** Hard ceiling on the credit we give a mover for RTT compensation (ms). */
  rttCreditCapMs?: number;
}

const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_RTT_CAP_MS = 100;

/** Return the current mover's remaining ms, used to schedule the flag timer. */
function remainingForMover(session: GameSession): number {
  const snap = session.snapshotClocks();
  return session.turn === 'w' ? snap.whiteMs : snap.blackMs;
}

interface Peer {
  playerId: string;
  socket: WebSocket;
  pingTimer?: NodeJS.Timeout;
}

export class WsHub {
  /** gameId → playerId → peer */
  private readonly peers = new Map<string, Map<string, Peer>>();
  private readonly flagTimers = new FlagTimers();
  private readonly rtt = new RttTracker();
  private readonly pingIntervalMs: number;
  private readonly rttCreditCapMs: number;

  constructor(private readonly deps: WsDeps) {
    this.pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.rttCreditCapMs = deps.rttCreditCapMs ?? DEFAULT_RTT_CAP_MS;
  }

  /** Shut down any pending timers — called from the service's onClose hook. */
  stop(): void {
    this.flagTimers.cancelAll();
    for (const slot of this.peers.values()) {
      for (const peer of slot.values()) if (peer.pingTimer) clearInterval(peer.pingTimer);
    }
  }

  /** Test seam: inject a known RTT sample so credit math is deterministic in tests. */
  recordRttSample(playerId: string, rttMs: number): void {
    this.rtt.sample(playerId, rttMs);
  }

  /** Attach a WebSocket server to an existing HTTP server. Expects upgrades at /ws/games/:gameId with
   *  an `x-player-id` header; rejects everything else at the HTTP layer. */
  attach(server: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(wss, req, socket, head);
    });

    return wss;
  }

  private async handleUpgrade(
    wss: WebSocketServer,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const match = /^\/ws\/games\/([0-9a-f-]{36})(?:\?|$)/.exec(req.url ?? '');
    const playerId = req.headers['x-player-id'];
    if (!match || typeof playerId !== 'string' || playerId.length === 0) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const gameId = match[1];
    if (!gameId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const session = await this.deps.sessions.acquire(gameId);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const color = session.colorOf(playerId);
    if (!color) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      this.onJoin(session, playerId, ws);
    });
  }

  private onJoin(session: GameSession, playerId: string, ws: WebSocket): void {
    const slot = this.peers.get(session.gameId) ?? new Map<string, Peer>();
    const prior = slot.get(playerId);
    if (prior) {
      if (prior.pingTimer) clearInterval(prior.pingTimer);
      prior.socket.close(4000, 'replaced');
    } else {
      // Only count as a new live connection if we weren't just replacing a prior socket for the same id.
      liveConnections.inc();
    }
    // Fresh connection → wipe any stale RTT samples from the dead socket.
    this.rtt.clear(playerId);
    const peer: Peer = { playerId, socket: ws };
    slot.set(playerId, peer);
    this.peers.set(session.gameId, slot);

    const color = session.colorOf(playerId);
    if (color) void this.sendGameState(session, playerId, color);

    // First join for this session arms the flag timer; subsequent joins (reconnect) don't need to.
    if (session.status === 'active' && slot.size === 1) {
      this.armFlagTimer(session);
    }

    // Ping loop for RTT sampling — we send a timestamp as the ping payload and compute the RTT when the
    // native pong echoes it back.
    peer.pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.ping(Buffer.from(String(Date.now())));
      } catch {
        // Writing a ping to a half-closed socket occasionally throws; the close handler will clean up.
      }
    }, this.pingIntervalMs);
    ws.on('pong', (data) => {
      const sent = Number(data.toString());
      if (!Number.isFinite(sent)) return;
      this.rtt.sample(playerId, Date.now() - sent);
    });

    ws.on('message', (data) => void this.onMessage(session, playerId, data.toString()));
    ws.on('close', () => this.onClose(session.gameId, playerId, ws));
  }

  private async sendGameState(
    session: GameSession,
    playerId: string,
    color: 'w' | 'b',
  ): Promise<void> {
    const clocks = session.snapshotClocks();
    const log = await getMoves(this.deps.db, session.gameId);
    this.sendTo(session.gameId, playerId, {
      type: 'gameState',
      gameId: session.gameId,
      color,
      fen: session.engine.fen(),
      turn: session.turn,
      whiteMs: clocks.whiteMs,
      blackMs: clocks.blackMs,
      moves: log.map((m) => ({ uci: m.uci, san: m.san })),
      status: session.status,
    });
  }

  private armFlagTimer(session: GameSession): void {
    this.flagTimers.schedule(session.gameId, remainingForMover(session), () => {
      // The mover whose timer fired loses; whichever colour is on turn at the moment is the one that
      // just ran out.
      const loser = session.turn;
      void this.endGame(session, loser === 'w' ? '0-1' : '1-0', 'flag');
    });
  }

  private async onMessage(session: GameSession, playerId: string, raw: string): Promise<void> {
    let parsed;
    try {
      parsed = ClientMessage.parse(JSON.parse(raw));
    } catch {
      this.sendTo(session.gameId, playerId, {
        type: 'error',
        code: 'malformed_message',
        message: 'could not parse message',
      });
      return;
    }

    if (parsed.type === 'sendMove') {
      await this.handleMove(session, playerId, parsed);
    } else if (parsed.type === 'resign') {
      await this.handleResign(session, playerId);
    }
  }

  private async handleMove(
    session: GameSession,
    playerId: string,
    msg: { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' },
  ): Promise<void> {
    if (session.status !== 'active') return;
    const color = session.colorOf(playerId);
    if (!color || color !== session.turn) {
      const clocks = session.snapshotClocks();
      this.sendTo(session.gameId, playerId, {
        type: 'moveAck',
        accepted: false,
        reason: 'not_your_turn',
        whiteMs: clocks.whiteMs,
        blackMs: clocks.blackMs,
      });
      movesTotal.inc({ result: 'rejected' });
      return;
    }

    const start = process.hrtime.bigint();
    const creditMs = creditFromMedian(this.rtt.median(playerId), this.rttCreditCapMs);
    rttCreditMsTotal.inc(creditMs);

    let applied;
    try {
      applied = session.applyMove(
        { from: msg.from, to: msg.to, promotion: msg.promotion },
        Date.now(),
        creditMs,
      );
    } catch (err) {
      const clocks = session.snapshotClocks();
      const reason =
        err instanceof TimeExpiredError
          ? 'flagged'
          : err instanceof IllegalMoveError
            ? 'illegal_move'
            : 'rejected';
      this.sendTo(session.gameId, playerId, {
        type: 'moveAck',
        accepted: false,
        reason,
        whiteMs: clocks.whiteMs,
        blackMs: clocks.blackMs,
      });
      movesTotal.inc({ result: reason });
      if (err instanceof TimeExpiredError) {
        await this.endGame(session, err.side === 'w' ? '0-1' : '1-0', 'flag');
      }
      return;
    }

    // Persist first — if the DB write is rejected (stale generation), the engine state is already past
    // this move, so we're forced to bail. In the current single-node setup that's effectively never.
    const ok = await appendMove(this.deps.db, {
      gameId: session.gameId,
      expectedGeneration: session.generation,
      move: {
        moveNumber: applied.moveNumber,
        ply: applied.ply,
        san: applied.san,
        uci: applied.uci,
        clockMs: color === 'w' ? applied.whiteMs : applied.blackMs,
      },
      whiteMs: applied.whiteMs,
      blackMs: applied.blackMs,
      turn: applied.turn,
    });
    if (!ok) {
      this.sendTo(session.gameId, playerId, {
        type: 'error',
        code: 'stale_generation',
        message: 'this server no longer owns the game',
      });
      movesTotal.inc({ result: 'stale_generation' });
      return;
    }

    movesTotal.inc({ result: 'accepted' });
    moveLatencySeconds.observe(Number(process.hrtime.bigint() - start) / 1e9);

    this.sendTo(session.gameId, playerId, {
      type: 'moveAck',
      accepted: true,
      whiteMs: applied.whiteMs,
      blackMs: applied.blackMs,
      creditMs,
    });
    this.broadcastExcept(session.gameId, playerId, {
      type: 'opponentMove',
      from: msg.from,
      to: msg.to,
      san: applied.san,
      whiteMs: applied.whiteMs,
      blackMs: applied.blackMs,
    });

    const terminal = session.terminalFromEngine();
    if (terminal) {
      await this.endGame(session, terminal.result, terminal.reason);
    } else {
      // The mover changed — the new mover's clock starts counting now.
      this.armFlagTimer(session);
    }
  }

  private async handleResign(session: GameSession, playerId: string): Promise<void> {
    if (session.status !== 'active') return;
    const color = session.colorOf(playerId);
    if (!color) return;
    const result: Result = color === 'w' ? '0-1' : '1-0';
    await this.endGame(session, result, 'resign');
  }

  private async endGame(session: GameSession, result: Result, reason: EndReason): Promise<void> {
    if (session.status !== 'active') return;
    session.finish();
    this.flagTimers.cancel(session.gameId);
    await finishGame(this.deps.db, {
      gameId: session.gameId,
      expectedGeneration: session.generation,
      result,
      endReason: reason,
    });
    this.broadcast(session.gameId, { type: 'gameEnd', result, endReason: reason });
    this.deps.sessions.release(session.gameId);
    const slot = this.peers.get(session.gameId);
    if (slot) {
      for (const peer of slot.values()) {
        if (peer.pingTimer) clearInterval(peer.pingTimer);
        this.rtt.clear(peer.playerId);
        liveConnections.dec();
        peer.socket.close(1000, 'game ended');
      }
      this.peers.delete(session.gameId);
    }
  }

  private onClose(gameId: string, playerId: string, ws: WebSocket): void {
    const slot = this.peers.get(gameId);
    const peer = slot?.get(playerId);
    if (peer && peer.socket === ws) {
      if (peer.pingTimer) clearInterval(peer.pingTimer);
      slot?.delete(playerId);
      this.rtt.clear(playerId);
      liveConnections.dec();
      if (slot && slot.size === 0) this.peers.delete(gameId);
    }
  }

  private sendTo(gameId: string, playerId: string, msg: ServerMessage): void {
    const peer = this.peers.get(gameId)?.get(playerId);
    if (peer) send(peer.socket, msg);
  }

  private broadcast(gameId: string, msg: ServerMessage): void {
    const slot = this.peers.get(gameId);
    if (!slot) return;
    for (const peer of slot.values()) send(peer.socket, msg);
  }

  private broadcastExcept(gameId: string, exceptPlayerId: string, msg: ServerMessage): void {
    const slot = this.peers.get(gameId);
    if (!slot) return;
    for (const peer of slot.values()) {
      if (peer.playerId === exceptPlayerId) continue;
      send(peer.socket, msg);
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
