// Typed WebSocket session for a live game. Zod-validates every inbound frame; outbound frames are typed
// against @chess/protocol. The event surface is a tight 4-event stream — `state` fires once on join
// (and on reconnect, if the caller rebuilds the session), `move` on each opponent move, `end` once at
// terminal, `error` for anything else.

import { ServerMessage, type GameState as GameStateMsg } from '@chess/protocol';
import { ProtocolError } from './errors.js';

/** Shape of a WebSocket constructor compatible with both the browser's native WS and Node's `ws`
 *  package — the latter accepts a third options arg that the browser's version silently ignores. */
export interface WebSocketCtor {
  new (
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ): WebSocket;
}

export interface ConnectOpts {
  /** WS endpoint — either from `matchmaking.wsUrl` or `/games/:id`'s `wsUrl`. */
  wsUrl: string;
  gameId: string;
  playerId: string;
  token: string;
  /** Replaces the global WebSocket (lets Node tests inject the `ws` package). */
  webSocketImpl?: WebSocketCtor;
}

export type GameEvent =
  | { type: 'state'; state: GameStateMsg }
  | {
      type: 'move';
      from: string;
      to: string;
      san: string;
      whiteMs: number;
      blackMs: number;
    }
  | {
      type: 'ack';
      accepted: boolean;
      reason?: string;
      whiteMs: number;
      blackMs: number;
      creditMs?: number;
    }
  | {
      type: 'end';
      result: '1-0' | '0-1' | '1/2-1/2';
      endReason: 'checkmate' | 'stalemate' | 'draw' | 'flag' | 'resign';
    }
  | { type: 'error'; code: string; message: string }
  | { type: 'closed'; code: number; reason: string };

export type GameListener = (event: GameEvent) => void;

export class GameSession {
  private readonly ws: WebSocket;
  private readonly listeners = new Set<GameListener>();

  constructor(opts: ConnectOpts) {
    const WS: WebSocketCtor = opts.webSocketImpl ?? (WebSocket as unknown as WebSocketCtor);
    // Node tests get real headers via the `ws` package's third arg; browsers ignore it silently and
    // we rely on the server accepting the query-param fallback (gap tracked separately).
    const url = `${opts.wsUrl.replace(/\/+$/, '')}/ws/games/${encodeURIComponent(opts.gameId)}`;
    this.ws = new WS(url, [], {
      headers: { 'x-player-id': opts.playerId, authorization: `Bearer ${opts.token}` },
    });

    this.ws.addEventListener('message', (ev) => this.onFrame(ev.data));
    this.ws.addEventListener('close', (ev) => {
      const closeEvent = ev as unknown as { code: number; reason: string };
      this.emit({ type: 'closed', code: closeEvent.code, reason: closeEvent.reason });
    });
    this.ws.addEventListener('error', () => {
      this.emit({ type: 'error', code: 'ws_error', message: 'socket error' });
    });
  }

  on(listener: GameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendMove(from: string, to: string, moveNumber: number, promotion?: 'q' | 'r' | 'b' | 'n'): void {
    this.send({
      type: 'sendMove',
      from,
      to,
      moveNumber,
      ...(promotion ? { promotion } : {}),
    });
  }

  resign(): void {
    this.send({ type: 'resign' });
  }

  close(): void {
    this.ws.close(1000, 'client');
  }

  private send(msg: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onFrame(raw: unknown): void {
    let parsed;
    try {
      const text = typeof raw === 'string' ? raw : (raw as { toString(): string }).toString();
      parsed = ServerMessage.parse(JSON.parse(text));
    } catch (err) {
      this.emit({
        type: 'error',
        code: 'protocol_error',
        message: err instanceof ProtocolError ? err.message : 'invalid server frame',
      });
      return;
    }

    switch (parsed.type) {
      case 'gameState':
        this.emit({ type: 'state', state: parsed });
        break;
      case 'opponentMove':
        this.emit({
          type: 'move',
          from: parsed.from,
          to: parsed.to,
          san: parsed.san,
          whiteMs: parsed.whiteMs,
          blackMs: parsed.blackMs,
        });
        break;
      case 'moveAck':
        this.emit({
          type: 'ack',
          accepted: parsed.accepted,
          ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
          whiteMs: parsed.whiteMs,
          blackMs: parsed.blackMs,
          ...(parsed.creditMs !== undefined ? { creditMs: parsed.creditMs } : {}),
        });
        break;
      case 'gameEnd':
        this.emit({ type: 'end', result: parsed.result, endReason: parsed.endReason });
        break;
      case 'error':
        this.emit({ type: 'error', code: parsed.code, message: parsed.message });
        break;
    }
  }

  private emit(ev: GameEvent): void {
    for (const l of this.listeners) l(ev);
  }
}
