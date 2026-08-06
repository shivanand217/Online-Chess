// Drizzle schema — the single source of truth for the Postgres data model (mirrors docs/02-lld.md).
// drizzle-kit reads this to generate SQL migrations; repositories and services get their row types from
// the `$infer` exports at the bottom, so the DB shape and the TS types can never drift. Hand-written.
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

/** Registered accounts. Rating is denormalised here for fast reads; it is derivable from finished games. */
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
  // Top-N leaderboard walks this index in rating order and stops early.
  (t) => [index('idx_players_rating').on(t.rating.desc())],
);

/** One chess game. `generation` is the fencing token (LLD Deep Dive 2): every mutating write guards on it. */
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
    whiteMs: integer('white_ms').notNull(), // remaining clock, authoritative
    blackMs: integer('black_ms').notNull(),
    turn: char('turn', { length: 1 }).$type<'w' | 'b'>().notNull(),
    status: text('status').$type<'active' | 'finished'>().notNull().default('active'),
    result: text('result').$type<'1-0' | '0-1' | '1/2-1/2'>(),
    endReason: text('end_reason'), // checkmate | stalemate | draw | flag | resign
    whiteRatingStart: integer('white_rating_start').notNull(), // snapshot → self-contained ELO delta
    blackRatingStart: integer('black_rating_start').notNull(),
    generation: integer('generation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Partial index: the matchmaker / game-server only ever scan active games.
  (t) => [
    index('idx_games_active')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
  ],
);

/** Append-only move log. The board is never stored — it is always re-derived by replaying these moves. */
export const moves = pgTable(
  'moves',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.gameId),
    moveNumber: integer('move_number').notNull(),
    ply: integer('ply').notNull(), // half-move index, 0-based
    san: text('san').notNull(), // 'Nf3'
    uci: text('uci').notNull(), // 'g1f3'
    clockMs: integer('clock_ms').notNull(), // mover's remaining time after the move
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Ordered replay: (game, ply) is unique and the natural sort key.
  (t) => [primaryKey({ columns: [t.gameId, t.ply] })],
);

/** Audit/analytics record of a matchmaking request; the live pool itself lives in Redis, not here. */
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

// Row types inferred from the schema — imported by repositories and services so nothing hand-maintains them.
export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type Move = typeof moves.$inferSelect;
export type NewMove = typeof moves.$inferInsert;
export type MatchRequest = typeof matchRequests.$inferSelect;
export type NewMatchRequest = typeof matchRequests.$inferInsert;
