CREATE TYPE "public"."reservation_status" AS ENUM('HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "auditoriums" (
	"id" serial PRIMARY KEY NOT NULL,
	"cinema_id" integer NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auditoriums_cinema_name_uniq" UNIQUE("cinema_id","name"),
	CONSTRAINT "auditoriums_capacity_check" CHECK ("auditoriums"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "cinemas" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cinemas_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "movies" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"title_pt_br" text,
	"release_year" smallint NOT NULL,
	"duration_minutes" integer,
	"synopsis" text,
	"genre" text,
	"poster_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movies_title_release_year_uniq" UNIQUE("title","release_year"),
	CONSTRAINT "movies_duration_minutes_check" CHECK ("movies"."duration_minutes" IS NULL OR "movies"."duration_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservation_seats" (
	"reservation_id" integer NOT NULL,
	"seat_id" integer NOT NULL,
	"screening_id" integer NOT NULL,
	"auditorium_id" integer NOT NULL,
	CONSTRAINT "reservation_seats_pkey" PRIMARY KEY("reservation_id","seat_id")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"screening_id" integer NOT NULL,
	"status" "reservation_status" DEFAULT 'HELD' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "reservations_id_screening_uniq" UNIQUE("id","screening_id")
);
--> statement-breakpoint
CREATE TABLE "screenings" (
	"id" serial PRIMARY KEY NOT NULL,
	"movie_id" integer NOT NULL,
	"auditorium_id" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"price_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screenings_auditorium_id_uniq" UNIQUE("auditorium_id","id"),
	CONSTRAINT "screenings_auditorium_starts_uniq" UNIQUE("auditorium_id","starts_at"),
	CONSTRAINT "screenings_ends_after_starts_check" CHECK ("screenings"."ends_at" > "screenings"."starts_at"),
	CONSTRAINT "screenings_price_cents_check" CHECK ("screenings"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" serial PRIMARY KEY NOT NULL,
	"auditorium_id" integer NOT NULL,
	"row_label" text NOT NULL,
	"seat_number" integer NOT NULL,
	CONSTRAINT "seats_auditorium_row_number_uniq" UNIQUE("auditorium_id","row_label","seat_number"),
	CONSTRAINT "seats_auditorium_id_uniq" UNIQUE("auditorium_id","id"),
	CONSTRAINT "seats_seat_number_check" CHECK ("seats"."seat_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "auditoriums" ADD CONSTRAINT "auditoriums_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_reservation_fk" FOREIGN KEY ("reservation_id","screening_id") REFERENCES "public"."reservations"("id","screening_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_seat_fk" FOREIGN KEY ("auditorium_id","seat_id") REFERENCES "public"."seats"("auditorium_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_screening_fk" FOREIGN KEY ("auditorium_id","screening_id") REFERENCES "public"."screenings"("auditorium_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_screening_id_screenings_id_fk" FOREIGN KEY ("screening_id") REFERENCES "public"."screenings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "public"."movies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_auditorium_id_auditoriums_id_fk" FOREIGN KEY ("auditorium_id") REFERENCES "public"."auditoriums"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_auditorium_id_auditoriums_id_fk" FOREIGN KEY ("auditorium_id") REFERENCES "public"."auditoriums"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservation_seats_screening_seat_idx" ON "reservation_seats" USING btree ("screening_id","seat_id");--> statement-breakpoint
CREATE INDEX "reservations_screening_status_idx" ON "reservations" USING btree ("screening_id","status");--> statement-breakpoint
CREATE INDEX "screenings_auditorium_starts_idx" ON "screenings" USING btree ("auditorium_id","starts_at");--> statement-breakpoint
CREATE INDEX "screenings_movie_starts_idx" ON "screenings" USING btree ("movie_id","starts_at");--> statement-breakpoint
-- Phase 1 hand-appended statements (Drizzle cannot express exclusion
-- constraints; managed explicitly, see docs/adr/0001-*). The btree_gist
-- extension ships with the official postgres:16 image (contrib modules).
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
-- No two screenings may overlap in the same auditorium. Adjacent screenings
-- (one ends exactly when the next starts) are allowed: tstzrange is [).
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_no_overlap_excl" EXCLUDE USING gist ("auditorium_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&);