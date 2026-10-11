// Gateway auth: `@fastify/jwt` registers the sign/verify helpers. `/auth/signup` creates a new player
// with a bcrypt-hashed password; `/auth/token` exchanges username+password for a short-lived HS256 JWT.
// Error responses are deliberately generic (401 on both unknown user and wrong password) to avoid an
// enumeration oracle.
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  getPlayerByUsername,
  hashPassword,
  insertPlayer,
  verifyPassword,
  type Database,
} from '@chess/db';
import { SignupRequest, TokenRequest } from '@chess/protocol';

export interface AuthDeps {
  db: Database;
  secret: string;
  expiresIn: string;
  /** Max attempts per IP against auth routes within `rateLimitWindowMs`. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

/** JWT claims we embed. `sub` is the playerId; usernames come from the DB on each request. */
export interface AuthClaims {
  sub: string;
  username: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthClaims;
    user: AuthClaims;
  }
}

export async function registerAuth(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  await app.register(fastifyJwt, {
    secret: deps.secret,
    sign: { expiresIn: deps.expiresIn, algorithm: 'HS256' },
  });

  // Per-route rate limit for auth endpoints only. Keyed by the client IP; a shared Redis adapter
  // would be a drop-in upgrade (`redis` option on the plugin), currently in-memory which is enough
  // for a single-replica gateway. The default errorResponseBuilder returns 429 with Retry-After.
  const authRateLimit = {
    max: deps.rateLimitMax,
    timeWindow: deps.rateLimitWindowMs,
    keyGenerator: (req: FastifyRequest) => req.ip,
  };

  app.post('/auth/signup', { config: { rateLimit: authRateLimit } }, async (req, reply) => {
    const parsed = SignupRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_request', details: parsed.error.flatten() };
    }
    const existing = await getPlayerByUsername(deps.db, parsed.data.username);
    if (existing) {
      reply.code(409);
      return { error: 'username_taken' };
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const player = await insertPlayer(deps.db, {
      username: parsed.data.username,
      passwordHash,
    });
    const token = await reply.jwtSign({ sub: player.playerId, username: player.username });
    reply.code(201);
    return { token, playerId: player.playerId, username: player.username };
  });

  app.post('/auth/token', { config: { rateLimit: authRateLimit } }, async (req, reply) => {
    const parsed = TokenRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_request', details: parsed.error.flatten() };
    }
    const player = await getPlayerByUsername(deps.db, parsed.data.username);
    const ok = player ? await verifyPassword(parsed.data.password, player.passwordHash) : false;
    if (!player || !ok) {
      reply.code(401);
      return { error: 'invalid_credentials' };
    }
    const token = await reply.jwtSign({ sub: player.playerId, username: player.username });
    return { token, playerId: player.playerId, username: player.username };
  });
}

/** Decorator for `preHandler` on protected routes. On success `req.user` holds the token claims. */
export function requireAuth() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401);
      await reply.send({ error: 'unauthorized' });
    }
  };
}
