// Wire contracts shared by client and server, defined once as zod schemas so both sides validate and
// infer types from exactly the same source.
import { z } from 'zod';

/** Time control identifier, e.g. 'blitz-3-2' = 3 min each + 2s increment per move. */
export const TimeControl = z.string().regex(/^[a-z]+-\d+-\d+$/);
export type TimeControl = z.infer<typeof TimeControl>;

// --- REST ---------------------------------------------------------------------------------------------

export const MatchmakingRequest = z.object({ timeControl: TimeControl });
export type MatchmakingRequest = z.infer<typeof MatchmakingRequest>;

export const MatchmakingResponse = z.object({
  gameId: z.string().uuid(),
  color: z.enum(['w', 'b']),
  opponent: z.object({
    playerId: z.string().uuid(),
    username: z.string(),
    rating: z.number().int(),
  }),
  timeControl: TimeControl,
});
export type MatchmakingResponse = z.infer<typeof MatchmakingResponse>;

/** Published on `match:<requestId>` when the matchmaker pairs a waiter; the two sides' payloads mirror
 *  each other with the colour flipped. */
export const MatchNotification = z.object({
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

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('moveAck'),
    accepted: z.boolean(),
    reason: z.string().optional(),
    whiteMs: z.number().int(),
    blackMs: z.number().int(),
  }),
  z.object({
    type: z.literal('opponentMove'),
    from: z.string(),
    to: z.string(),
    san: z.string(),
    whiteMs: z.number().int(),
    blackMs: z.number().int(),
  }),
  z.object({ type: z.literal('gameEnd'), result: z.string(), endReason: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
