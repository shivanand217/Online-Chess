// Typed errors so UI code can `instanceof`-check instead of parsing status codes everywhere.

export class ChessClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ChessClientError';
  }
}

/** Login was rejected or the token has expired. */
export class AuthError extends ChessClientError {
  constructor(message = 'unauthorized') {
    super(message, 401);
    this.name = 'AuthError';
  }
}

/** The server returned 404 for a resource the client requested. */
export class NotFoundError extends ChessClientError {
  constructor(message = 'not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

/** Matchmaking long-poll completed without finding a match (gateway 408 / sweeper `expired`). */
export class MatchmakingTimeoutError extends ChessClientError {
  constructor() {
    super('match_timeout', 408);
    this.name = 'MatchmakingTimeoutError';
  }
}

/** A WebSocket frame failed zod validation — the server violated the agreed protocol. */
export class ProtocolError extends ChessClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
