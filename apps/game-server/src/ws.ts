// WebSocket layer. One connection per playerId per game; a second connection from the same player
// replaces the first (prevents orphan sockets after a reconnect). Every mutating message hits Postgres
// via `appendMove` or `finishGame` BEFORE anything is broadcast — the DB is the source of truth, the
// network is just a notification channel.
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { IllegalMoveError } from '@chess/chess-engine';
import { appendMove, finishGame, type Database } from '@chess/db';
import { ClientMessage, type ServerMessage } from '@chess/protocol';
import type { EndReason, GameSession } from './session.js';
import { TimeExpiredError } from './session.js';
import type { SessionManager } from './sessions.js';
import type { Result } from '@chess/chess-engine';

export interface WsDeps {
  db: Database;
  sessions: SessionManager;
}

interface Peer {
  playerId: string;
  socket: WebSocket;
}

export class WsHub {
  /** gameId → playerId → peer */
  private readonly peers = new Map<string, Map<string, Peer>>();

  constructor(private readonly deps: WsDeps) {}

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
    if (prior) prior.socket.close(4000, 'replaced');
    slot.set(playerId, { playerId, socket: ws });
    this.peers.set(session.gameId, slot);

    const color = session.colorOf(playerId);
    if (color) send(ws, this.gameStateFor(session, color));

    ws.on('message', (data) => void this.onMessage(session, playerId, data.toString()));
    ws.on('close', () => this.onClose(session.gameId, playerId, ws));
  }

  private gameStateFor(session: GameSession, color: 'w' | 'b'): ServerMessage {
    const clocks = session.snapshotClocks();
    // The current FEN captures the position the client needs to render; the detailed per-move log is a
    // separate REST concern (not needed for live play, only for replay UIs).
    return {
      type: 'gameState',
      gameId: session.gameId,
      color,
      fen: session.engine.fen(),
      turn: session.turn,
      whiteMs: clocks.whiteMs,
      blackMs: clocks.blackMs,
      moves: [],
      status: session.status,
    };
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
      return;
    }

    let applied;
    try {
      applied = session.applyMove({ from: msg.from, to: msg.to, promotion: msg.promotion });
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
      return;
    }

    this.sendTo(session.gameId, playerId, {
      type: 'moveAck',
      accepted: true,
      whiteMs: applied.whiteMs,
      blackMs: applied.blackMs,
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
      for (const peer of slot.values()) peer.socket.close(1000, 'game ended');
      this.peers.delete(session.gameId);
    }
  }

  private onClose(gameId: string, playerId: string, ws: WebSocket): void {
    const slot = this.peers.get(gameId);
    const peer = slot?.get(playerId);
    if (peer && peer.socket === ws) {
      slot?.delete(playerId);
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
