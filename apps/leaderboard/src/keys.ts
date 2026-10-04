// Redis key layout for the leaderboard. Score = rating, member = playerId. Reads use ZREVRANGE for top-N
// and ZREVRANK for own-rank — both O(log N) over a btree-backed sorted set.

export const LEADERBOARD_KEY = 'leaderboard:global';
