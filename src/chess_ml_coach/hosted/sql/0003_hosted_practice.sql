-- Hosted training: the classic UI (Dashboard, Practice, Mistakes, Progress) backed by
-- Postgres instead of per-player local files. Only FastAPI reads or writes these
-- tables; browser roles get no grants.

-- The player an account is currently working on (the classic "active profile").
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS active_player_id uuid REFERENCES players(id) ON DELETE SET NULL;

-- The completed analysis whose results a player currently trains on.
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS active_job_id uuid REFERENCES analysis_jobs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS active_dependency_hash text;

-- Puzzles imported from each validated puzzles artifact. A set is keyed by the
-- artifact's dependency hash, so a newer analysis never mixes with an older one.
CREATE TABLE IF NOT EXISTS player_puzzles (
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    dependency_hash text NOT NULL,
    puzzle_id text NOT NULL,
    game_id text NOT NULL,
    ply integer NOT NULL,
    fen_before text NOT NULL,
    color text NOT NULL,
    game_label text NOT NULL,
    move_label text NOT NULL,
    your_move_san text NOT NULL,
    your_move_uci text NOT NULL,
    best_move_san text NOT NULL,
    best_move_uci text NOT NULL,
    cpl integer NOT NULL,
    quality text NOT NULL,
    opening text NOT NULL,
    eco text NOT NULL,
    game_phase text NOT NULL,
    source_url text NOT NULL DEFAULT '',
    motif text NOT NULL,
    difficulty integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, dependency_hash, puzzle_id)
);

-- Spaced-repetition state per account, player, and puzzle. Puzzle ids are stable
-- across re-analysis (game, ply, best move), so history carries over.
CREATE TABLE IF NOT EXISTS practice_states (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    puzzle_id text NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    correct_attempts integer NOT NULL DEFAULT 0 CHECK (correct_attempts >= 0),
    consecutive_correct integer NOT NULL DEFAULT 0 CHECK (consecutive_correct >= 0),
    last_reviewed_at timestamptz,
    next_review_at timestamptz NOT NULL,
    mastered boolean NOT NULL DEFAULT false,
    PRIMARY KEY (account_id, player_id, puzzle_id)
);

CREATE TABLE IF NOT EXISTS practice_reviews (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    puzzle_id text NOT NULL,
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    answer text NOT NULL,
    correct boolean NOT NULL,
    previous_interval_days integer NOT NULL,
    next_interval_days integer NOT NULL
);

CREATE INDEX IF NOT EXISTS practice_reviews_account_player_time
ON practice_reviews (account_id, player_id, reviewed_at);

-- One row per finished adaptive drill, for the Progress page's calculation metrics.
CREATE TABLE IF NOT EXISTS adaptive_drills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    puzzle_id text NOT NULL,
    succeeded boolean NOT NULL,
    user_moves_accepted integer NOT NULL CHECK (user_moves_accepted >= 0),
    current_ply integer NOT NULL CHECK (current_ply >= 0),
    continuation_attempts integer NOT NULL DEFAULT 0 CHECK (continuation_attempts >= 0),
    continuation_correct integer NOT NULL DEFAULT 0 CHECK (continuation_correct >= 0),
    finished_at timestamptz NOT NULL DEFAULT now(),
    CHECK (continuation_correct <= continuation_attempts)
);

CREATE INDEX IF NOT EXISTS adaptive_drills_account_player
ON adaptive_drills (account_id, player_id);

DO $$
DECLARE
    table_name text;
    browser_role text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'player_puzzles', 'practice_states', 'practice_reviews', 'adaptive_drills'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
        FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated']
        LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
                EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, browser_role);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;
