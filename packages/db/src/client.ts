// Pooled Postgres connection + typed Drizzle instance. Every service constructs one `DbHandle` at startup
// and shares it; the pool is the unit of connection reuse and backpressure. Hand-written.
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

/** The typed Drizzle handle, aware of every table in {@link schema}. This is what repositories accept. */
export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: Pool;
  /** Drain the pool on graceful shutdown. */
  close: () => Promise<void>;
}

/** Create a pooled connection and the Drizzle instance over it. */
export function createDb(connectionString: string, poolOptions: PoolConfig = {}): DbHandle {
  const pool = new Pool({ connectionString, ...poolOptions });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
