// Domain metrics for the leaderboard. Pending-games gauge is set per sweeper tick; apply duration is
// observed per successful apply.
import { gauge, histogram, type Gauge, type Histogram } from '@chess/telemetry';

export const eloApplyDurationSeconds: Histogram<'result'> = histogram<'result'>({
  name: 'leaderboard_elo_apply_duration_seconds',
  help: 'End-to-end time for applyRatingForGame (DB tx + Redis ZADD)',
  labelNames: ['result'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

export const pendingGames: Gauge<string> = gauge({
  name: 'leaderboard_pending_games',
  help: 'Finished games waiting for the ELO apply (snapshot per sweeper tick)',
});
