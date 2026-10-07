// Focused unit tests for the HTTP side — mock fetch so we exercise the SDK's shape, status handling,
// and error class mapping without standing up the whole service stack.
import { describe, expect, it, vi } from 'vitest';
import { AuthError, MatchmakingTimeoutError, NotFoundError } from './errors.js';
import { ChessHttpClient } from './http.js';

function mockFetch(responders: Array<(url: string, init: RequestInit) => Response>) {
  let i = 0;
  return vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const responder = responders[i++];
    if (!responder) throw new Error(`unexpected fetch call ${i}: ${String(url)}`);
    return responder(String(url), init);
  }) as unknown as typeof fetch;
}

const PLAYER = '11111111-1111-1111-1111-111111111111';
const GAME = '22222222-2222-2222-2222-222222222222';

describe('ChessHttpClient.login', () => {
  it('posts to /auth/token and stores the session', async () => {
    const fetchImpl = mockFetch([
      (url) => {
        expect(url).toBe('http://localhost:3000/auth/token');
        return new Response(
          JSON.stringify({ token: 'tok.en', playerId: PLAYER, username: 'alice' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    ]);
    const c = new ChessHttpClient({ gatewayUrl: 'http://localhost:3000', fetchImpl });
    const session = await c.login(PLAYER);
    expect(session.token).toBe('tok.en');
    expect(c.authSession?.username).toBe('alice');
  });

  it('throws NotFoundError on 404', async () => {
    const fetchImpl = mockFetch([
      () => new Response('{"error":"player_not_found"}', { status: 404 }),
    ]);
    const c = new ChessHttpClient({ gatewayUrl: 'http://localhost:3000', fetchImpl });
    await expect(c.login(PLAYER)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ChessHttpClient.findMatch', () => {
  it('attaches the Bearer token and returns the typed match response', async () => {
    const fetchImpl = mockFetch([
      (_url, init) => {
        expect((init.headers as Headers).get('authorization')).toBe('Bearer tok.en');
        return new Response(
          JSON.stringify({
            gameId: GAME,
            color: 'w',
            opponent: { playerId: 'o-id', username: 'bob', rating: 1500 },
            timeControl: 'blitz-3-2',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    ]);
    const c = new ChessHttpClient({ gatewayUrl: 'http://localhost:3000', fetchImpl });
    c.setSession({ token: 'tok.en', playerId: PLAYER, username: 'alice' });
    const match = await c.findMatch('blitz-3-2');
    expect(match.gameId).toBe(GAME);
    expect(match.color).toBe('w');
  });

  it('maps 408 to MatchmakingTimeoutError', async () => {
    const fetchImpl = mockFetch([() => new Response('{}', { status: 408 })]);
    const c = new ChessHttpClient({ gatewayUrl: 'http://localhost:3000', fetchImpl });
    c.setSession({ token: 'tok.en', playerId: PLAYER, username: 'alice' });
    await expect(c.findMatch('blitz-3-2')).rejects.toBeInstanceOf(MatchmakingTimeoutError);
  });

  it('clears the session and throws AuthError on 401', async () => {
    const fetchImpl = mockFetch([() => new Response('{"error":"unauthorized"}', { status: 401 })]);
    const c = new ChessHttpClient({ gatewayUrl: 'http://localhost:3000', fetchImpl });
    c.setSession({ token: 'stale.tok', playerId: PLAYER, username: 'alice' });
    await expect(c.findMatch('blitz-3-2')).rejects.toBeInstanceOf(AuthError);
    expect(c.authSession).toBeUndefined();
  });

  it('throws AuthError when no session is set', async () => {
    const c = new ChessHttpClient({
      gatewayUrl: 'http://localhost:3000',
      fetchImpl: mockFetch([]),
    });
    await expect(c.findMatch('blitz-3-2')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('ChessHttpClient.getGame', () => {
  it('returns the typed snapshot', async () => {
    const fetchImpl = mockFetch([
      (url) => {
        expect(url).toBe(`http://localhost:3000/games/${GAME}`);
        return new Response(
          JSON.stringify({
            gameId: GAME,
            whiteId: PLAYER,
            blackId: 'other',
            timeControl: 'blitz-3-2',
            whiteMs: 180000,
            blackMs: 180000,
            turn: 'w',
            status: 'active',
            result: null,
            endReason: null,
          }),
          { status: 200 },
        );
      },
    ]);
    const c = new ChessHttpClient({ gatewayUrl: 'http://localhost:3000', fetchImpl });
    const game = await c.getGame(GAME);
    expect(game.status).toBe('active');
    expect(game.whiteMs).toBe(180_000);
  });

  it('maps 404 to NotFoundError', async () => {
    const fetchImpl = mockFetch([() => new Response('{}', { status: 404 })]);
    const c = new ChessHttpClient({ gatewayUrl: 'http://localhost:3000', fetchImpl });
    await expect(c.getGame(GAME)).rejects.toBeInstanceOf(NotFoundError);
  });
});
