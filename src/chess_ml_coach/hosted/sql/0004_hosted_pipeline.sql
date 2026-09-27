-- The classic Pipeline page in hosted mode: stages run independently, like local mode.

-- Analysis is kept per game, so a later sync only analyzes new games. A game analyzed
-- once (per player and configuration) is never analyzed again; its rows live in the
-- checkpoint that first recorded it.
CREATE TABLE IF NOT EXISTS analyzed_games (
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    analysis_config_id uuid NOT NULL REFERENCES analysis_configs(id) ON DELETE CASCADE,
    game_id text NOT NULL,
    checkpoint_id uuid NOT NULL REFERENCES analysis_checkpoints(id) ON DELETE CASCADE,
    move_count integer NOT NULL CHECK (move_count >= 0),
    analyzed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, analysis_config_id, game_id)
);

CREATE INDEX IF NOT EXISTS analyzed_games_checkpoint ON analyzed_games (checkpoint_id);

-- The games a job still had to analyze when it was created, in manifest order.
CREATE TABLE IF NOT EXISTS job_units (
    job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    unit_index integer NOT NULL CHECK (unit_index >= 0),
    game_id text NOT NULL,
    PRIMARY KEY (job_id, unit_index),
    UNIQUE (job_id, game_id)
);

-- Sync runs on the server in the background and is shared by everyone studying a player.
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS sync_started_at timestamptz,
    ADD COLUMN IF NOT EXISTS sync_finished_at timestamptz,
    ADD COLUMN IF NOT EXISTS sync_error text,
    ADD COLUMN IF NOT EXISTS sync_progress jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_sync_status_check;
ALTER TABLE players ADD CONSTRAINT players_sync_status_check
    CHECK (sync_status IN ('idle', 'running', 'succeeded', 'failed'));

-- Results (puzzles, model, report) are built from the analyzed games by any entitled
-- account, independently of an analysis job and its worker lease.
ALTER TABLE analysis_upload_grants
    ALTER COLUMN job_id DROP NOT NULL,
    ALTER COLUMN lease_token_digest DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS player_id uuid REFERENCES players(id) ON DELETE CASCADE;

ALTER TABLE analysis_upload_grants DROP CONSTRAINT IF EXISTS analysis_upload_grants_owner;
ALTER TABLE analysis_upload_grants ADD CONSTRAINT analysis_upload_grants_owner CHECK (
    (purpose = 'checkpoint' AND job_id IS NOT NULL AND lease_token_digest IS NOT NULL)
    OR (purpose = 'artifact' AND player_id IS NOT NULL)
);

DO $$
DECLARE
    table_name text;
    browser_role text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['analyzed_games', 'job_units']
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
