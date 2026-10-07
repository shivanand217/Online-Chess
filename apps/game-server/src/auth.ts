// WS authentication: every upgrade must carry a JWT (either `Authorization: Bearer <t>` for Node
// clients or `?token=<t>` on the URL for browsers, which can't send custom headers on a WS handshake).
// We verify the same HS256 token the gateway mints and extract the playerId from `sub`.
import type { IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';

export interface VerifiedToken {
  playerId: string;
}

export type TokenVerifier = (req: IncomingMessage) => VerifiedToken | undefined;

export function createTokenVerifier(secret: string): TokenVerifier {
  return (req) => {
    const token = extractToken(req);
    if (!token) return undefined;
    try {
      const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') return undefined;
      const sub = decoded.sub;
      if (typeof sub !== 'string' || sub.length === 0) return undefined;
      return { playerId: sub };
    } catch {
      return undefined;
    }
  };
}

function extractToken(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams.get('token');
  return q && q.length > 0 ? q : undefined;
}
