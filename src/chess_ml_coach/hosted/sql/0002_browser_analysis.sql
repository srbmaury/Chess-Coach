-- Browser-coordinated shared analysis.
--
-- Browsers compute; FastAPI (connecting as the table owner) is the only writer of
-- coordination state. Browser roles get narrowly granted, RLS-filtered reads only.

-- Jobs: browser lease, checkpoint cursor, provenance --------------------------

UPDATE analysis_jobs SET status = 'paused' WHERE status = 'stopping';

ALTER TABLE analysis_jobs DROP CONSTRAINT IF EXISTS analysis_jobs_status_check;
ALTER TABLE analysis_jobs ADD CONSTRAINT analysis_jobs_status_check CHECK (status IN (
    'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'
));

DROP INDEX IF EXISTS analysis_jobs_one_active_target;
CREATE UNIQUE INDEX analysis_jobs_one_active_target
ON analysis_jobs (player_id, analysis_config_id, input_game_set_hash)
WHERE status IN ('queued', 'running', 'paused');

ALTER TABLE analysis_jobs
    ADD COLUMN IF NOT EXISTS analysis_config_hash text,
    ADD COLUMN IF NOT EXISTS engine_build_hash text,
    ADD COLUMN IF NOT EXISTS manifest_storage_key text,
    ADD COLUMN IF NOT EXISTS lease_token_digest text,
    ADD COLUMN IF NOT EXISTS lease_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS lease_device_id text,
    ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
    ADD COLUMN IF NOT EXISTS checkpoint_sequence integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS checkpoint_manifest_key text,
    ADD COLUMN IF NOT EXISTS checkpoint_hash text,
    ADD COLUMN IF NOT EXISTS compute_source text NOT NULL DEFAULT 'community_computed',
    ADD COLUMN IF NOT EXISTS last_error_code text;

ALTER TABLE analysis_jobs DROP CONSTRAINT IF EXISTS analysis_jobs_checkpoint_sequence_check;
ALTER TABLE analysis_jobs ADD CONSTRAINT analysis_jobs_checkpoint_sequence_check
    CHECK (checkpoint_sequence >= 0);
ALTER TABLE analysis_jobs DROP CONSTRAINT IF EXISTS analysis_jobs_progress_bounds;
ALTER TABLE analysis_jobs ADD CONSTRAINT analysis_jobs_progress_bounds
    CHECK (completed_work <= total_work);
ALTER TABLE analysis_jobs DROP CONSTRAINT IF EXISTS analysis_jobs_compute_source_check;
ALTER TABLE analysis_jobs ADD CONSTRAINT analysis_jobs_compute_source_check
    CHECK (compute_source IN ('community_computed', 'server_verified'));
ALTER TABLE analysis_jobs DROP CONSTRAINT IF EXISTS analysis_jobs_lease_consistent;
ALTER TABLE analysis_jobs ADD CONSTRAINT analysis_jobs_lease_consistent CHECK (
    (lease_token_digest IS NULL) = (lease_account_id IS NULL)
    AND (lease_token_digest IS NULL) = (lease_device_id IS NULL)
    AND (lease_token_digest IS NULL) = (lease_expires_at IS NULL)
);

-- Subscribers: observation is independent of computation ----------------------

UPDATE job_subscribers SET state = 'stopped' WHERE state = 'inactive';

ALTER TABLE job_subscribers DROP CONSTRAINT IF EXISTS job_subscribers_state_check;
ALTER TABLE job_subscribers ADD CONSTRAINT job_subscribers_state_check
    CHECK (state IN ('active', 'stopped', 'completed'));
ALTER TABLE job_subscribers
    ADD COLUMN IF NOT EXISTS can_compute boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS job_subscribers_account_state
ON job_subscribers (account_id, state, job_id);

-- Players: latest canonical game manifest -------------------------------------

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS latest_manifest_hash text,
    ADD COLUMN IF NOT EXISTS latest_manifest_key text,
    ADD COLUMN IF NOT EXISTS latest_manifest_game_count integer,
    ADD COLUMN IF NOT EXISTS latest_manifest_at timestamptz;

-- Configurations and artifacts: provenance and quarantine ---------------------

ALTER TABLE analysis_configs
    ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS quarantined_at timestamptz;

ALTER TABLE derived_artifacts
    ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES analysis_jobs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS analysis_config_hash text,
    ADD COLUMN IF NOT EXISTS content_hash text,
    ADD COLUMN IF NOT EXISTS byte_size integer,
    ADD COLUMN IF NOT EXISTS compute_source text NOT NULL DEFAULT 'community_computed',
    ADD COLUMN IF NOT EXISTS quarantined_at timestamptz;

ALTER TABLE derived_artifacts DROP CONSTRAINT IF EXISTS derived_artifacts_compute_source_check;
ALTER TABLE derived_artifacts ADD CONSTRAINT derived_artifacts_compute_source_check
    CHECK (compute_source IN ('community_computed', 'server_verified'));

CREATE INDEX IF NOT EXISTS derived_artifacts_player_ready
ON derived_artifacts (player_id, artifact_type, created_at DESC)
WHERE status = 'ready' AND quarantined_at IS NULL;

-- Checkpoints: immutable, acknowledged batches of move analysis ----------------

CREATE TABLE IF NOT EXISTS analysis_checkpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    sequence integer NOT NULL CHECK (sequence > 0),
    storage_bucket text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    byte_size integer NOT NULL CHECK (byte_size > 0),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    result_count integer NOT NULL CHECK (result_count >= 0),
    first_unit integer NOT NULL CHECK (first_unit >= 0),
    last_unit integer NOT NULL,
    first_game_id text NOT NULL,
    last_game_id text NOT NULL,
    analysis_config_hash text NOT NULL,
    engine_build_hash text NOT NULL,
    uploader_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    uploader_device_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (last_unit >= first_unit),
    UNIQUE (job_id, sequence),
    UNIQUE (job_id, content_hash)
);

-- Upload grants: one short-lived grant per immutable object --------------------

CREATE TABLE IF NOT EXISTS analysis_upload_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('checkpoint', 'artifact')),
    sequence integer,
    artifact_type text,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL UNIQUE,
    byte_size integer NOT NULL CHECK (byte_size > 0),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    lease_token_digest text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((purpose = 'checkpoint') = (sequence IS NOT NULL)),
    CHECK ((purpose = 'artifact') = (artifact_type IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS analysis_upload_grants_job
ON analysis_upload_grants (job_id);

CREATE INDEX IF NOT EXISTS analysis_upload_grants_orphans
ON analysis_upload_grants (expires_at)
WHERE consumed_at IS NULL;

-- Private schema for trigger functions (never exposed through the Data API) ----

CREATE SCHEMA IF NOT EXISTS chess_private;
REVOKE ALL ON SCHEMA chess_private FROM PUBLIC;

-- Broadcast sanitized progress on a private topic. Account/device identifiers and
-- lease digests never leave the database; heartbeats alone do not broadcast.
CREATE OR REPLACE FUNCTION chess_private.broadcast_job_progress()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF to_regprocedure('realtime.send(jsonb, text, text, boolean)') IS NULL THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE'
        AND NEW.status IS NOT DISTINCT FROM OLD.status
        AND NEW.completed_work IS NOT DISTINCT FROM OLD.completed_work
        AND NEW.total_work IS NOT DISTINCT FROM OLD.total_work
        AND NEW.checkpoint_sequence IS NOT DISTINCT FROM OLD.checkpoint_sequence
        AND NEW.lease_token_digest IS NOT DISTINCT FROM OLD.lease_token_digest
    THEN
        RETURN NULL;
    END IF;
    PERFORM realtime.send(
        jsonb_build_object(
            'job_id', NEW.id,
            'status', NEW.status,
            'completed_work', NEW.completed_work,
            'total_work', NEW.total_work,
            'checkpoint_sequence', NEW.checkpoint_sequence,
            'worker_active', NEW.lease_token_digest IS NOT NULL,
            'updated_at', NEW.updated_at
        ),
        'progress',
        'job:' || NEW.id::text,
        true
    );
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION chess_private.broadcast_job_progress() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;

DROP TRIGGER IF EXISTS analysis_jobs_broadcast_progress ON analysis_jobs;
CREATE TRIGGER analysis_jobs_broadcast_progress
AFTER INSERT OR UPDATE ON analysis_jobs
FOR EACH ROW EXECUTE FUNCTION chess_private.broadcast_job_progress();

-- Explicit grants and row level security --------------------------------------

DO $$
DECLARE
    table_name text;
    browser_role text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'schema_migrations', 'accounts', 'subscriptions', 'players', 'account_profiles',
        'games', 'player_games', 'analysis_configs', 'analysis_jobs', 'job_subscribers',
        'move_analyses', 'derived_artifacts', 'puzzle_reviews', 'stripe_events',
        'audit_events', 'analysis_checkpoints', 'analysis_upload_grants'
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

    FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA chess_private FROM %I', browser_role);
            EXECUTE format(
                'REVOKE ALL ON FUNCTION chess_private.broadcast_job_progress() FROM %I',
                browser_role
            );
            EXECUTE format('REVOKE ALL ON FUNCTION public.set_updated_at() FROM %I', browser_role);
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
        OR to_regprocedure('auth.uid()') IS NULL
    THEN
        RAISE NOTICE 'Supabase roles are absent; browser read policies were not created';
        RETURN;
    END IF;

    -- Column grants keep lease, uploader, and storage internals server-only.
    GRANT SELECT (id, email, created_at) ON public.accounts TO authenticated;
    GRANT SELECT (id, account_id, player_id, slot_type, state, created_at)
        ON public.account_profiles TO authenticated;
    GRANT SELECT (id, canonical_username, display_username, last_synced_at)
        ON public.players TO authenticated;
    GRANT SELECT (job_id, account_id, state, can_compute, created_at, updated_at)
        ON public.job_subscribers TO authenticated;
    GRANT SELECT (
        id, player_id, status, stage, completed_work, total_work, checkpoint_sequence,
        compute_source, analysis_config_hash, created_at, started_at, finished_at, updated_at
    ) ON public.analysis_jobs TO authenticated;
    GRANT SELECT (job_id, sequence, content_hash, result_count, first_unit, last_unit, created_at)
        ON public.analysis_checkpoints TO authenticated;
    GRANT SELECT (
        id, player_id, artifact_type, dependency_hash, schema_version, status,
        compute_source, analysis_config_hash, content_hash, byte_size, created_at
    ) ON public.derived_artifacts TO authenticated;

    DROP POLICY IF EXISTS accounts_read_own ON public.accounts;
    CREATE POLICY accounts_read_own ON public.accounts
        FOR SELECT TO authenticated
        USING (id = (SELECT auth.uid()));

    DROP POLICY IF EXISTS account_profiles_read_own ON public.account_profiles;
    CREATE POLICY account_profiles_read_own ON public.account_profiles
        FOR SELECT TO authenticated
        USING (account_id = (SELECT auth.uid()));

    DROP POLICY IF EXISTS players_read_entitled ON public.players;
    CREATE POLICY players_read_entitled ON public.players
        FOR SELECT TO authenticated
        USING (EXISTS (
            SELECT 1 FROM public.account_profiles profile
            WHERE profile.account_id = (SELECT auth.uid())
              AND profile.player_id = players.id
              AND profile.state <> 'removed'
        ));

    DROP POLICY IF EXISTS job_subscribers_read_own ON public.job_subscribers;
    CREATE POLICY job_subscribers_read_own ON public.job_subscribers
        FOR SELECT TO authenticated
        USING (account_id = (SELECT auth.uid()));

    DROP POLICY IF EXISTS analysis_jobs_read_subscribed ON public.analysis_jobs;
    CREATE POLICY analysis_jobs_read_subscribed ON public.analysis_jobs
        FOR SELECT TO authenticated
        USING (EXISTS (
            SELECT 1 FROM public.job_subscribers subscriber
            WHERE subscriber.account_id = (SELECT auth.uid())
              AND subscriber.job_id = analysis_jobs.id
              AND subscriber.state IN ('active', 'completed')
        ));

    DROP POLICY IF EXISTS analysis_checkpoints_read_subscribed ON public.analysis_checkpoints;
    CREATE POLICY analysis_checkpoints_read_subscribed ON public.analysis_checkpoints
        FOR SELECT TO authenticated
        USING (EXISTS (
            SELECT 1 FROM public.job_subscribers subscriber
            WHERE subscriber.account_id = (SELECT auth.uid())
              AND subscriber.job_id = analysis_checkpoints.job_id
              AND subscriber.state IN ('active', 'completed')
        ));

    DROP POLICY IF EXISTS derived_artifacts_read_entitled ON public.derived_artifacts;
    CREATE POLICY derived_artifacts_read_entitled ON public.derived_artifacts
        FOR SELECT TO authenticated
        USING (
            quarantined_at IS NULL
            AND status = 'ready'
            AND (
                account_id = (SELECT auth.uid())
                OR (account_id IS NULL AND EXISTS (
                    SELECT 1 FROM public.account_profiles profile
                    WHERE profile.account_id = (SELECT auth.uid())
                      AND profile.player_id = derived_artifacts.player_id
                      AND profile.state <> 'removed'
                ))
            )
        );

    -- Private Broadcast authorization: only active subscribers of job:<uuid> receive.
    IF to_regclass('realtime.messages') IS NOT NULL
        AND to_regprocedure('realtime.topic()') IS NOT NULL
    THEN
        DROP POLICY IF EXISTS chess_job_progress_receive ON realtime.messages;
        CREATE POLICY chess_job_progress_receive ON realtime.messages
            FOR SELECT TO authenticated
            USING (
                realtime.messages.extension = 'broadcast'
                AND EXISTS (
                    SELECT 1 FROM public.job_subscribers subscriber
                    WHERE subscriber.account_id = (SELECT auth.uid())
                      AND subscriber.state = 'active'
                      AND 'job:' || subscriber.job_id::text = (SELECT realtime.topic())
                )
            );
    ELSE
        RAISE NOTICE 'realtime.messages is absent; create the Broadcast policy after enabling Realtime';
    END IF;
END;
$$;
