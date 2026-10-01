// Drizzle schema — the single source of truth for the Postgres data model. Repositories and services
// pull their row types from the `$infer` exports at the bottom, so the DB shape and TS types never drift.
import { sql } from 'drizzle-orm';
import {
  char,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Rating is denormalised onto `players` for fast reads; it stays derivable from finished games. */
export const players = pgTable(
  'players',
  {
    playerId: uuid('player_id').primaryKey().defaultRandom(),
    username: text('username').notNull().unique(),
    rating: integer('rating').notNull().default(1500),
    gamesPlayed: integer('games_played').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_players_rating').on(t.rating.desc())],
);

/** `generation` is the fencing token — every mutating write guards on it so a stale owner can't
 *  overwrite a reassigned game. */
export const games = pgTable(
  'games',
  {
    gameId: uuid('game_id').primaryKey().defaultRandom(),
    whiteId: uuid('white_id')
      .notNull()
      .references(() => players.playerId),
    blackId: uuid('black_id')
      .notNull()
      .references(() => players.playerId),
    timeControl: text('time_control').notNull(),
    whiteMs: integer('white_ms').notNull(),
    blackMs: integer('black_ms').notNull(),
    turn: char('turn', { length: 1 }).$type<'w' | 'b'>().notNull(),
    status: text('status').$type<'active' | 'finished'>().notNull().default('active'),
    result: text('result').$type<'1-0' | '0-1' | '1/2-1/2'>(),
    endReason: text('end_reason'),
    whiteRatingStart: integer('white_rating_start').notNull(),
    blackRatingStart: integer('black_rating_start').notNull(),
    generation: integer('generation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_games_active')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  ],
);

/** Append-only. The board is never stored — it's always rebuilt by replaying moves. */
export const moves = pgTable(
  'moves',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.gameId),
    moveNumber: integer('move_number').notNull(),
    ply: integer('ply').notNull(),
    san: text('san').notNull(),
    uci: text('uci').notNull(),
    clockMs: integer('clock_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.ply] })],
);

/** Audit log; the live matchmaking pool lives in Redis, not here. */
export const matchRequests = pgTable('match_requests', {
  requestId: uuid('request_id').primaryKey(),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.playerId),
  rating: integer('rating').notNull(),
  timeControl: text('time_control').notNull(),
  status: text('status').$type<'pending' | 'matched' | 'expired'>().notNull(),
  gameId: uuid('game_id').references(() => games.gameId),
  enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type Move = typeof moves.$inferSelect;
export type NewMove = typeof moves.$inferInsert;
export type MatchRequest = typeof matchRequests.$inferSelect;
export type NewMatchRequest = typeof matchRequests.$inferInsert;
