// Programmatic migration runner used by the integration tests and, later, by a pre-deploy Job.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export async function runMigrations(
  db: Database,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
