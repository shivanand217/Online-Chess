// Gateway-side counters for the matchmaking long-poll — one data point per client-visible outcome.
import { counter, type Counter } from '@chess/telemetry';

export const matchmakingOutcomes: Counter<'outcome'> = counter<'outcome'>({
  name: 'gateway_matchmaking_outcomes_total',
  help: 'Final outcome of a matchmaking long-poll held by the gateway',
  labelNames: ['outcome'],
});
