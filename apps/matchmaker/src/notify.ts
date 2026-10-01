// Post-claim pairing: persist the Game row and tell both sides. Called immediately after `tryClaim`
// returns a peer; by that point both waiters have been ZREMmed, so this is the only writer that will
// ever see them. Metadata hashes are deleted last so a crash mid-notify leaves a replayable record.
import type Redis from 'ioredis';
import { createGame, type Database } from '@chess/db';
import { parseTimeControl } from '@chess/domain';
import type { MatchNotification } from '@chess/protocol';
import { matchChannel, requestKey } from './keys.js';
import { getWaiter, type WaiterMetadata } from './pool.js';

export interface PlayerLookup {
  playerId: string;
  username: string;
  rating: number;
}

/** Caller-supplied lookup — the matchmaker doesn't own the players table, it just needs usernames. */
export type ResolvePlayer = (playerId: string) => Promise<PlayerLookup | undefined>;

export interface NotifyParams {
  callerRequestId: string;
  peerRequestId: string;
  resolvePlayer: ResolvePlayer;
}

export interface PairingResult {
  gameId: string;
  caller: MatchNotification;
  peer: MatchNotification;
}

/** Deterministic colour assignment keyed on requestId so a test can predict who plays white. */
function assignColors(aId: string, bId: string): { white: string; black: string } {
  return aId < bId ? { white: aId, black: bId } : { white: bId, black: aId };
}

export async function notifyPairing(
  redis: Redis,
  db: Database,
  params: NotifyParams,
): Promise<PairingResult | null> {
  const [callerWaiter, peerWaiter] = await Promise.all([
    getWaiter(redis, params.callerRequestId),
    getWaiter(redis, params.peerRequestId),
  ]);
  // If a prior crash already resolved this pairing, both hashes are gone and there's nothing to do.
  if (!callerWaiter || !peerWaiter) return null;

  const [callerPlayer, peerPlayer] = await Promise.all([
    params.resolvePlayer(callerWaiter.playerId),
    params.resolvePlayer(peerWaiter.playerId),
  ]);
  if (!callerPlayer || !peerPlayer) {
    throw new Error('unknown player on paired waiter');
  }

  const tc = parseTimeControl(callerWaiter.timeControl);
  const colors = assignColors(params.callerRequestId, params.peerRequestId);
  const whitePlayer = colors.white === params.callerRequestId ? callerPlayer : peerPlayer;
  const blackPlayer = colors.black === params.callerRequestId ? callerPlayer : peerPlayer;

  const game = await createGame(db, {
    whiteId: whitePlayer.playerId,
    blackId: blackPlayer.playerId,
    timeControl: callerWaiter.timeControl,
    whiteMs: tc.initialMs,
    blackMs: tc.initialMs,
    turn: 'w',
    whiteRatingStart: whitePlayer.rating,
    blackRatingStart: blackPlayer.rating,
  });

  const message = (
    forRequestId: string,
    me: WaiterMetadata,
    them: PlayerLookup,
  ): MatchNotification => ({
    requestId: forRequestId,
    gameId: game.gameId,
    color: forRequestId === colors.white ? 'w' : 'b',
    opponent: {
      playerId: them.playerId,
      username: them.username,
      rating: them.rating,
    },
    timeControl: me.timeControl,
  });

  const callerMsg = message(params.callerRequestId, callerWaiter, peerPlayer);
  const peerMsg = message(params.peerRequestId, peerWaiter, callerPlayer);

  // Publish before cleaning up the hashes: a subscriber hitting the channel after we delete the hash
  // still gets a valid payload, and a crash before cleanup just leaves orphans the sweeper can GC.
  await Promise.all([
    redis.publish(matchChannel(params.callerRequestId), JSON.stringify(callerMsg)),
    redis.publish(matchChannel(params.peerRequestId), JSON.stringify(peerMsg)),
  ]);
  await redis.del(requestKey(params.callerRequestId), requestKey(params.peerRequestId));

  return { gameId: game.gameId, caller: callerMsg, peer: peerMsg };
}
