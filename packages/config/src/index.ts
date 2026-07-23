// Loads and validates process environment into a typed config object used by all services. Hand-written.
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Per-service HTTP ports (health/metrics now; real routes in later phases)
  GATEWAY_PORT: z.coerce.number().int().default(3000),
  MATCHMAKER_PORT: z.coerce.number().int().default(3001),
  SESSION_ROUTER_PORT: z.coerce.number().int().default(3002),
  GAME_SERVER_PORT: z.coerce.number().int().default(3003),
  LEADERBOARD_PORT: z.coerce.number().int().default(3004),

  // Backing services
  DATABASE_URL: z.string().default('postgres://chess:chess@localhost:5432/chess'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ETCD_HOSTS: z.string().default('http://localhost:2379'),
});

export type Config = z.infer<typeof EnvSchema>;

/** Parse the current environment (with optional overrides) into a validated Config. Throws on invalid env. */
export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  return EnvSchema.parse({ ...process.env, ...overrides });
}
