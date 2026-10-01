import { defineConfig } from 'drizzle-kit';

// `db:generate` reads schema → SQL (needs no DB); `db:migrate` applies it against DATABASE_URL.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://chess:chess@localhost:5432/chess',
  },
});
