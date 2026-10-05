// Domain metrics for the matchmaker. Registered against the shared @chess/telemetry registry so they
// land in /metrics alongside the HTTP RED metrics.
import { gauge, histogram, type Gauge, type Histogram } from '@chess/telemetry';

export const matchmakingWaitSeconds: Histogram<'timeControl'> = histogram<'timeControl'>({
  name: 'matchmaking_wait_seconds',
  help: 'Time a waiter spent in the pool before being paired',
  labelNames: ['timeControl'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
});

export const matchmakingPairs: Histogram<'timeControl' | 'outcome'> = histogram<
  'timeControl' | 'outcome'
>({
  name: 'matchmaking_pairs_total',
  help: 'Pairings produced by the sweeper, bucketed by outcome',
  labelNames: ['timeControl', 'outcome'],
  buckets: [1],
});

export const matchmakingPoolSize: Gauge<'timeControl'> = gauge<'timeControl'>({
  name: 'matchmaking_pool_size',
  help: 'Current number of waiters per time-control pool (set by each sweeper tick)',
  labelNames: ['timeControl'],
});
