// Typed env loader. Every service calls `loadConfig()` once at startup and shares the result.
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  GATEWAY_PORT: z.coerce.number().int().default(3000),
  MATCHMAKER_PORT: z.coerce.number().int().default(3001),
  SESSION_ROUTER_PORT: z.coerce.number().int().default(3002),
  GAME_SERVER_PORT: z.coerce.number().int().default(3003),
  LEADERBOARD_PORT: z.coerce.number().int().default(3004),

  DATABASE_URL: z.string().default('postgres://chess:chess@localhost:5432/chess'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ETCD_HOSTS: z.string().default('http://localhost:2379'),

  // Internal service URLs the gateway talks to.
  MATCHMAKER_URL: z.string().default('http://localhost:3001'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  return EnvSchema.parse({ ...process.env, ...overrides });
}
