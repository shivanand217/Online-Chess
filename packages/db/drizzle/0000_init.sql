CREATE TABLE "games" (
	"game_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"white_id" uuid NOT NULL,
	"black_id" uuid NOT NULL,
	"time_control" text NOT NULL,
	"white_ms" integer NOT NULL,
	"black_ms" integer NOT NULL,
	"turn" char(1) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"result" text,
	"end_reason" text,
	"white_rating_start" integer NOT NULL,
	"black_rating_start" integer NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"time_control" text NOT NULL,
	"status" text NOT NULL,
	"game_id" uuid,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"game_id" uuid NOT NULL,
	"move_number" integer NOT NULL,
	"ply" integer NOT NULL,
	"san" text NOT NULL,
	"uci" text NOT NULL,
	"clock_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moves_game_id_ply_pk" PRIMARY KEY("game_id","ply")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"player_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"rating" integer DEFAULT 1500 NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_white_id_players_player_id_fk" FOREIGN KEY ("white_id") REFERENCES "public"."players"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_black_id_players_player_id_fk" FOREIGN KEY ("black_id") REFERENCES "public"."players"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_requests" ADD CONSTRAINT "match_requests_player_id_players_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("player_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_requests" ADD CONSTRAINT "match_requests_game_id_games_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("game_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_games_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("game_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_games_active" ON "games" USING btree ("status") WHERE "games"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_players_rating" ON "players" USING btree ("rating" DESC NULLS LAST);