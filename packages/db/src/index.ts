// Placeholder for the Postgres access layer. Phase 1 adds the Drizzle schema (players/games/moves),
// drizzle-kit migrations, a pooled connection, and the generation-guarded move+clock write. Hand-written.

export const DB_MODULE_READY = false as const;

/** Temporary marker so the package builds/typechecks before Phase 1 fills it in. */
export function describe(): string {
  return 'db: Drizzle schema + repositories land in Phase 1 (docs/04-project-plan.md#phase-1)';
}
