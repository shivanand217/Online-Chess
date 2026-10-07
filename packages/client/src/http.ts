// HTTP side of the SDK — thin, typed wrappers over the gateway's REST surface. Token management is
// explicit: `login()` returns a session; the client doesn't persist it anywhere so the UI stays in
// control of where it lives (memory, localStorage, cookie).
import type { MatchmakingResponse, TokenResponse, TimeControl } from '@chess/protocol';
import { AuthError, ChessClientError, MatchmakingTimeoutError, NotFoundError } from './errors.js';

export interface AuthSession {
  token: string;
  playerId: string;
  username: string;
}

export interface GameSnapshot {
  gameId: string;
  whiteId: string;
  blackId: string;
  timeControl: string;
  whiteMs: number;
  blackMs: number;
  turn: 'w' | 'b';
  status: 'active' | 'finished';
  result: '1-0' | '0-1' | '1/2-1/2' | null;
  endReason: string | null;
  wsUrl?: string;
}

export interface HttpOptions {
  gatewayUrl: string;
  /** Replaces the global `fetch` (useful for Node servers that want to inject tracing). */
  fetchImpl?: typeof fetch;
}

export class ChessHttpClient {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private session: AuthSession | undefined;

  constructor(opts: HttpOptions) {
    this.root = opts.gatewayUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The currently authenticated session, if any. */
  get authSession(): AuthSession | undefined {
    return this.session;
  }

  /** Restore a previous session (e.g. from localStorage) without hitting the server. */
  setSession(session: AuthSession | undefined): void {
    this.session = session;
  }

  /** Mint a dev-mode token for a known playerId. Will be replaced by password login later. */
  async login(playerId: string): Promise<AuthSession> {
    const res = await this.fetchImpl(`${this.root}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId }),
    });
    if (res.status === 404) throw new NotFoundError('player_not_found');
    if (!res.ok) throw await this.rejectFromResponse(res, 'login_failed');
    const body = (await res.json()) as TokenResponse;
    this.session = { token: body.token, playerId: body.playerId, username: body.username };
    return this.session;
  }

  /** Long-poll for a pairing. Resolves with the match response, or throws `MatchmakingTimeoutError`
   *  when the gateway's hold expires (408). Cancels at the client side via `signal`. */
  async findMatch(timeControl: TimeControl, signal?: AbortSignal): Promise<MatchmakingResponse> {
    const res = await this.authed(`${this.root}/matchmaking`, {
      method: 'POST',
      body: JSON.stringify({ timeControl }),
      ...(signal ? { signal } : {}),
    });
    if (res.status === 408) throw new MatchmakingTimeoutError();
    if (!res.ok) throw await this.rejectFromResponse(res, 'matchmaking_failed');
    return (await res.json()) as MatchmakingResponse;
  }

  async getGame(gameId: string): Promise<GameSnapshot> {
    const res = await this.fetchImpl(`${this.root}/games/${encodeURIComponent(gameId)}`);
    if (res.status === 404) throw new NotFoundError('game_not_found');
    if (!res.ok) throw await this.rejectFromResponse(res, 'get_game_failed');
    return (await res.json()) as GameSnapshot;
  }

  private async authed(url: string, init: RequestInit & { body?: string } = {}): Promise<Response> {
    if (!this.session) throw new AuthError('no_session');
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('authorization', `Bearer ${this.session.token}`);
    const res = await this.fetchImpl(url, { ...init, headers });
    if (res.status === 401) {
      this.session = undefined;
      throw new AuthError();
    }
    return res;
  }

  private async rejectFromResponse(res: Response, fallback: string): Promise<ChessClientError> {
    let message = fallback;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      /* non-JSON body is fine; use the fallback */
    }
    return new ChessClientError(message, res.status);
  }
}
