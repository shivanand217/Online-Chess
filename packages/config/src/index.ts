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
  SESSION_ROUTER_URL: z.string().default('http://localhost:3002'),

  // Game server advertises this URL to etcd so the session router (and clients, via it) can reach it.
  GAME_SERVER_PUBLIC_URL: z.string().default('ws://localhost:3003'),

  // Secret used to sign + verify the gateway's JWTs. The dev default MUST be overridden in any
  // deployment the open internet can see.
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-in-production'),
  /** Lifetime of a freshly minted token. Suffixed with a unit per `@fastify/jwt`'s conventions. */
  JWT_EXPIRES_IN: z.string().default('12h'),

  /** Comma-separated allowlist of origins the browser frontend may call from. The dev default accepts
   *  localhost on common frontend ports; production should list the real origin. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:4000,http://127.0.0.1:4000'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  return EnvSchema.parse({ ...process.env, ...overrides });
}
