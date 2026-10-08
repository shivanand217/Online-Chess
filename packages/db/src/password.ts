// Thin wrapper over bcryptjs so the gateway + seed script share one place to hash and verify. Cost 10
// is the industry default — ~100ms per op on modern hardware, which is slow enough to make a brute-force
// stream expensive and fast enough for interactive sign-in.
import bcrypt from 'bcryptjs';

const COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

/** Constant-time compare. Returns false (not throws) for a malformed hash. */
export async function verifyPassword(
  plain: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
