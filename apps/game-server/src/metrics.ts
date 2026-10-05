// Domain metrics for the game-server. Observed from WsHub + SessionManager.
import {
  counter,
  gauge,
  histogram,
  type Counter,
  type Gauge,
  type Histogram,
} from '@chess/telemetry';

export const activeGames: Gauge<string> = gauge({
  name: 'game_server_active_games',
  help: 'Number of live game sessions held in memory on this instance',
});

export const movesTotal: Counter<'result'> = counter<'result'>({
  name: 'game_server_moves_total',
  help: 'Accepted moves applied to live games',
  labelNames: ['result'],
});

export const moveLatencySeconds: Histogram<string> = histogram({
  name: 'game_server_move_latency_seconds',
  help: 'Time from receiving a sendMove frame to broadcasting opponentMove (includes DB write)',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const rttCreditMsTotal: Counter<string> = counter({
  name: 'game_server_rtt_credit_ms_total',
  help: 'Total milliseconds credited to movers for RTT compensation',
});

export const liveConnections: Gauge<string> = gauge({
  name: 'game_server_live_connections',
  help: 'Open player WebSocket connections across all live sessions',
});
