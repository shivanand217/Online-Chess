// Gateway auth: `@fastify/jwt` registers the sign/verify helpers; the login route hands out a short-lived
// HS256 token for a known playerId. Real password-backed login is a follow-up — today the client proves
// which player it is simply by naming a playerId that exists in Postgres.
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPlayer, type Database } from '@chess/db';
import { TokenRequest } from '@chess/protocol';

export interface AuthDeps {
  db: Database;
  secret: string;
  expiresIn: string;
}

/** The shape we embed in the JWT. `sub` is the playerId; usernames come from the DB on each request. */
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

  app.post('/auth/token', async (req, reply) => {
    const parsed = TokenRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_request', details: parsed.error.flatten() };
    }
    const player = await getPlayer(deps.db, parsed.data.playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player_not_found' };
    }
    const token = await reply.jwtSign({ sub: player.playerId, username: player.username });
    return { token, playerId: player.playerId, username: player.username };
  });
}

/** Decorator that routes attach via `preHandler` to require a valid Bearer token. On success it leaves
 *  `req.user` set to the token's claims. On failure it returns 401. */
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
