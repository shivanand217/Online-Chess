// Thin typed client for the session router's /route/:gameId. Best-effort: a 503 or network error returns
// `undefined` so the matchmaking response still goes out — the client can retry via /games/:id later.

export interface RouteResult {
  nodeId: string;
  wsUrl: string;
}

export interface RouterClient {
  routeFor: (gameId: string) => Promise<RouteResult | undefined>;
}

export function createRouterClient(baseUrl: string): RouterClient {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async routeFor(gameId) {
      try {
        const res = await fetch(`${root}/route/${encodeURIComponent(gameId)}`);
        if (!res.ok) return undefined;
        const body = (await res.json()) as RouteResult;
        return body;
      } catch {
        return undefined;
      }
    },
  };
}
