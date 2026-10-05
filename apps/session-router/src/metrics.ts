// Session-router metric: how many game servers are currently in the ring.
import { gauge, type Gauge } from '@chess/telemetry';

export const ringMembers: Gauge<string> = gauge({
  name: 'session_router_ring_members',
  help: 'Number of game-server members in the consistent-hash ring',
});
