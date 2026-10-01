// Pooled Postgres connection + typed Drizzle instance. Each service builds one `DbHandle` at startup.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

export function createDb(connectionString: string, poolOptions: PoolConfig = {}): DbHandle {
  const pool = new Pool({ connectionString, ...poolOptions });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
