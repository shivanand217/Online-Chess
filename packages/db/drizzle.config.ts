// drizzle-kit configuration: where the schema lives, where generated SQL migrations go, and how to reach
// Postgres for `db:migrate`. `db:generate` (schema → SQL) needs no database. Hand-written.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://chess:chess@localhost:5432/chess',
  },
});
