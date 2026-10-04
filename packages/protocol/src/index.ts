// Wire contracts shared by client and server, defined once as zod schemas so both sides validate and
// infer types from exactly the same source.
import { z } from 'zod';

/** Time control identifier, e.g. 'blitz-3-2' = 3 min each + 2s increment per move. */
export const TimeControl = z.string().regex(/^[a-z]+-\d+-\d+$/);
export type TimeControl = z.infer<typeof TimeControl>;

// --- REST ---------------------------------------------------------------------------------------------

export const MatchmakingRequest = z.object({ timeControl: TimeControl });
export type MatchmakingRequest = z.infer<typeof MatchmakingRequest>;

/** Gateway → matchmaker RPC when the gateway holds a long-poll on behalf of a client. The gateway owns
 *  the `requestId` so it can subscribe to the match channel before telling the matchmaker to enqueue. */
export const EnqueueRequest = z.object({
  requestId: z.string().uuid(),
  playerId: z.string().uuid(),
  timeControl: TimeControl,
});
export type EnqueueRequest = z.infer<typeof EnqueueRequest>;

export const EnqueueResponse = z.object({
  requestId: z.string().uuid(),
});
export type EnqueueResponse = z.infer<typeof EnqueueResponse>;

export const MatchmakingResponse = z.object({
  gameId: z.string().uuid(),
  color: z.enum(['w', 'b']),
  opponent: z.object({
    playerId: z.string().uuid(),
    username: z.string(),
    rating: z.number().int(),
  }),
  timeControl: TimeControl,
  /** Game-server WebSocket URL from the session router. Absent if the router is empty / unreachable; the
   *  client can retry via `GET /games/:id` once a server is up. */
  wsUrl: z.string().url().optional(),
});
export type MatchmakingResponse = z.infer<typeof MatchmakingResponse>;

/** Published on `match:<requestId>` when the matchmaker pairs a waiter; the two sides' payloads mirror
 *  each other with the colour flipped. */
export const MatchNotification = z.object({
  type: z.literal('matched'),
  requestId: z.string().uuid(),
  gameId: z.string().uuid(),
  color: z.enum(['w', 'b']),
  opponent: z.object({
    playerId: z.string().uuid(),
    username: z.string(),
    rating: z.number().int(),
  }),
  timeControl: TimeControl,
});
export type MatchNotification = z.infer<typeof MatchNotification>;

/** Published on `match:<requestId>` when the sweeper gives up (past `maxWaitMs`); the gateway turns this
 *  into a 408 for the waiting client. */
export const MatchExpired = z.object({
  type: z.literal('expired'),
  requestId: z.string().uuid(),
});
export type MatchExpired = z.infer<typeof MatchExpired>;

/** Everything a subscriber on a `match:<requestId>` channel may receive. */
export const MatchResult = z.discriminatedUnion('type', [MatchNotification, MatchExpired]);
export type MatchResult = z.infer<typeof MatchResult>;

// --- WebSocket: client → server -----------------------------------------------------------------------

export const SendMove = z.object({
  type: z.literal('sendMove'),
  from: z.string().length(2),
  to: z.string().length(2),
  moveNumber: z.number().int().nonnegative(),
  promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
});
export const ClientMessage = z.discriminatedUnion('type', [
  SendMove,
  z.object({ type: z.literal('resign') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --- WebSocket: server → client -----------------------------------------------------------------------

/** Sent once per connection right after a WS join, so the client knows which colour it plays and the
 *  live clocks / move log without a separate REST call. */
export const GameState = z.object({
  type: z.literal('gameState'),
  gameId: z.string().uuid(),
  color: z.enum(['w', 'b']),
  fen: z.string(),
  turn: z.enum(['w', 'b']),
  whiteMs: z.number().int(),
  blackMs: z.number().int(),
  moves: z.array(z.object({ uci: z.string(), san: z.string() })),
  status: z.enum(['active', 'finished']),
});
export type GameState = z.infer<typeof GameState>;

export const ServerMessage = z.discriminatedUnion('type', [
  GameState,
  z.object({
    type: z.literal('moveAck'),
    accepted: z.boolean(),
    reason: z.string().optional(),
    whiteMs: z.number().int(),
    blackMs: z.number().int(),
    /** Milliseconds the server credited back to the mover for round-trip transit. Present on an
     *  accepted move; absent on rejections. */
    creditMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('opponentMove'),
    from: z.string(),
    to: z.string(),
    san: z.string(),
    whiteMs: z.number().int(),
    blackMs: z.number().int(),
  }),
  z.object({
    type: z.literal('gameEnd'),
    result: z.enum(['1-0', '0-1', '1/2-1/2']),
    endReason: z.enum(['checkmate', 'stalemate', 'draw', 'flag', 'resign']),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
