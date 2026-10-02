// One dedicated Redis subscriber for the whole gateway: PSUBSCRIBE match:* once, dispatch each payload to
// the per-request listener. Keeping a single connection out of the long-poll hot path means a burst of
// requests doesn't translate into a burst of Redis connects. Listeners register BEFORE enqueueing so an
// instant pairing can't publish into an empty map.
import Redis from 'ioredis';
import { MatchResult } from '@chess/protocol';

export interface MatchSubscriber {
  waitFor: (requestId: string, timeoutMs: number) => Promise<MatchResult | null>;
  stop: () => Promise<void>;
}

export async function createMatchSubscriber(redisUrl: string): Promise<MatchSubscriber> {
  const sub = new Redis(redisUrl);
  const listeners = new Map<string, (payload: MatchResult) => void>();

  sub.on('pmessage', (_pattern, channel, message) => {
    const requestId = channel.slice('match:'.length);
    const listener = listeners.get(requestId);
    if (!listener) return;
    const parsed = MatchResult.safeParse(JSON.parse(message));
    if (parsed.success) listener(parsed.data);
  });

  await sub.psubscribe('match:*');

  return {
    waitFor: (requestId, timeoutMs) =>
      new Promise((resolve) => {
        const done = (value: MatchResult | null): void => {
          clearTimeout(timer);
          listeners.delete(requestId);
          resolve(value);
        };
        const timer = setTimeout(() => done(null), timeoutMs);
        listeners.set(requestId, done);
      }),
    stop: async () => {
      listeners.clear();
      await sub.punsubscribe('match:*').catch(() => undefined);
      sub.disconnect();
    },
  };
}
