// Manual smoke against a live Redis (defaults to `pnpm stack:up`'s instance). Enqueues a hot waiter plus
// N contenders, races them through `tryClaim` in parallel, prints the pairing graph, and verifies the
// three invariants. Invoke with `pnpm --filter @chess/matchmaker smoke`.
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { registerClaimScript, tryClaim } from '../src/claim.js';
import { poolKey } from '../src/keys.js';
import { enqueue, poolSize, type WaiterMetadata } from '../src/pool.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TIME_CONTROL = process.env.TIME_CONTROL ?? 'blitz-3-2';
const CONTENDERS = Number(process.env.CONTENDERS ?? 20);
const HOT_RATING = Number(process.env.HOT_RATING ?? 1500);
const SPREAD = Number(process.env.SPREAD ?? 30);
const WINDOW = Number(process.env.WINDOW ?? 50);

function waiter(rating: number): WaiterMetadata {
  return {
    requestId: randomUUID(),
    playerId: randomUUID(),
    rating,
    timeControl: TIME_CONTROL,
    enqueuedAt: Date.now(),
  };
}

const short = (id: string): string => id.slice(0, 8);

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL);
  registerClaimScript(redis);

  await redis.del(poolKey(TIME_CONTROL));

  console.log(
    `\n→ matchmaker smoke: ${CONTENDERS + 1} waiters on ${TIME_CONTROL}, ±${WINDOW} window`,
  );
  console.log(`  redis: ${REDIS_URL}\n`);

  const hot = waiter(HOT_RATING);
  await enqueue(redis, hot);
  console.log(`  hot waiter: ${short(hot.requestId)} @ rating ${hot.rating}`);

  const contenders = Array.from({ length: CONTENDERS }, (_, i) => {
    const offset = Math.round((i / Math.max(1, CONTENDERS - 1) - 0.5) * 2 * SPREAD);
    return waiter(HOT_RATING + offset);
  });
  await Promise.all(contenders.map((c) => enqueue(redis, c)));

  console.log(`  pool before: ${await poolSize(redis, TIME_CONTROL)} members\n`);

  const t0 = Date.now();
  const results = await Promise.all(
    contenders.map((c) =>
      tryClaim(redis, {
        timeControl: c.timeControl,
        requestId: c.requestId,
        rating: c.rating,
        window: WINDOW,
      }),
    ),
  );
  const elapsed = Date.now() - t0;

  console.log('  pairings:');
  for (let i = 0; i < contenders.length; i++) {
    const caller = contenders[i];
    const peer = results[i];
    if (!caller) continue;
    const peerLabel =
      peer === null ? '(no match)' : peer === hot.requestId ? `${short(peer)} ← HOT` : short(peer);
    console.log(`    ${short(caller.requestId)} @${caller.rating}  →  ${peerLabel}`);
  }

  const winners = results.filter((r): r is string => r !== null);
  const winnersOfHot = winners.filter((w) => w === hot.requestId);
  const duplicates = winners.length - new Set(winners).size;
  const selfMatches = contenders.filter((c, i) => results[i] === c.requestId).length;

  console.log(`\n  pool after:  ${await poolSize(redis, TIME_CONTROL)} members`);
  console.log(`  pairings:    ${winners.length} / ${contenders.length}`);
  console.log(`  elapsed:     ${elapsed} ms`);

  console.log('\n  invariants:');
  console.log(
    `    hot waiter booked at most once:   ${winnersOfHot.length <= 1 ? '✓' : '✗'} (count=${winnersOfHot.length})`,
  );
  console.log(
    `    no winner appears twice:          ${duplicates === 0 ? '✓' : '✗'} (duplicates=${duplicates})`,
  );
  console.log(
    `    no self-matches:                  ${selfMatches === 0 ? '✓' : '✗'} (self-matches=${selfMatches})`,
  );

  const ok = winnersOfHot.length <= 1 && duplicates === 0 && selfMatches === 0;
  console.log(`\n  verdict: ${ok ? '✓ all invariants hold' : '✗ INVARIANT BROKEN'}\n`);

  redis.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
