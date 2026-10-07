// Public surface of @chess/client. The HTTP + WS pieces are standalone — a browser only needs to import
// what it uses. `createChessClient` is a convenience factory that wires both together.
import { ChessHttpClient, type HttpOptions } from './http.js';
import { GameSession, type ConnectOpts, type WebSocketCtor } from './game-session.js';

export { ChessHttpClient } from './http.js';
export type { AuthSession, GameSnapshot, HttpOptions } from './http.js';
export { GameSession } from './game-session.js';
export type { ConnectOpts, GameEvent, GameListener, WebSocketCtor } from './game-session.js';
export * from './errors.js';

export interface ChessClientOptions extends HttpOptions {
  /** Replaces the global WebSocket for Node tests. */
  webSocketImpl?: WebSocketCtor;
}

export interface ChessClient {
  http: ChessHttpClient;
  /** Open a WS session for a game. The caller already knows the gameId + wsUrl (from matchmaking) and
   *  the SDK handles the handshake + typed message stream. */
  connectToGame: (opts: Omit<ConnectOpts, 'webSocketImpl'>) => GameSession;
}

export function createChessClient(opts: ChessClientOptions): ChessClient {
  const http = new ChessHttpClient(opts);
  return {
    http,
    connectToGame: (connectOpts) =>
      new GameSession({
        ...connectOpts,
        ...(opts.webSocketImpl ? { webSocketImpl: opts.webSocketImpl } : {}),
      }),
  };
}
