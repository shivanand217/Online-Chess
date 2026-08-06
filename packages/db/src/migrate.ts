// Programmatic migration runner. Used by the integration tests (against a Testcontainers Postgres) and,
// later, by the pre-deploy migration Job (docs/06-deployment.md). Hand-written.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

/** Absolute path to the generated SQL migrations, resolved relative to this module. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/** Apply all pending migrations from {@link MIGRATIONS_DIR} (or a caller-supplied folder). */
export async function runMigrations(
  db: Database,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
