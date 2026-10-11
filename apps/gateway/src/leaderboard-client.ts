// Fetch wrapper around the leaderboard service. The gateway proxies these reads so a browser only
// ever talks to one origin (and the leaderboard service doesn't need to deal with CORS).

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  username: string;
  rating: number;
}

export interface LeaderboardPage {
  entries: LeaderboardEntry[];
  offset: number;
  limit: number;
}

export interface PlayerRank {
  playerId: string;
  username: string;
  rating: number;
  rank: number | null;
  indexedRating: number | null;
}

export interface LeaderboardClient {
  topN: (limit: number, offset: number) => Promise<LeaderboardPage>;
  playerRank: (playerId: string) => Promise<PlayerRank | undefined>;
}

export function createLeaderboardClient(baseUrl: string): LeaderboardClient {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async topN(limit, offset) {
      const url = new URL(`${root}/leaderboard`);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`leaderboard topN failed: ${res.status}`);
      return (await res.json()) as LeaderboardPage;
    },
    async playerRank(playerId) {
      const res = await fetch(`${root}/players/${encodeURIComponent(playerId)}/rank`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`playerRank failed: ${res.status}`);
      return (await res.json()) as PlayerRank;
    },
  };
}
