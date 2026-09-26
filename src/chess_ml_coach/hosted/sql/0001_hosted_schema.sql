CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    stripe_customer_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stripe_subscription_id text NOT NULL UNIQUE,
    stripe_price_id text NOT NULL,
    status text NOT NULL CHECK (status IN (
        'incomplete', 'incomplete_expired', 'trialing', 'active',
        'past_due', 'canceled', 'unpaid', 'paused'
    )),
    current_period_end timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    last_event_created_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chesscom_player_id bigint UNIQUE,
    canonical_username text NOT NULL UNIQUE,
    display_username text NOT NULL,
    profile_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
    slot_type text NOT NULL CHECK (slot_type IN ('free', 'paid')),
    state text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'read_only', 'removed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_profiles_active_player
ON account_profiles (account_id, player_id)
WHERE state <> 'removed';

CREATE UNIQUE INDEX IF NOT EXISTS account_profiles_one_free_slot
ON account_profiles (account_id)
WHERE slot_type = 'free' AND state <> 'removed';

CREATE TABLE IF NOT EXISTS games (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chesscom_url text UNIQUE,
    pgn_hash text NOT NULL UNIQUE,
    pgn_storage_key text NOT NULL,
    game_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS player_games (
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_color text NOT NULL CHECK (player_color IN ('white', 'black')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, game_id)
);

CREATE TABLE IF NOT EXISTS analysis_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stockfish_version text NOT NULL,
    depth integer NOT NULL CHECK (depth > 0),
    thresholds jsonb NOT NULL,
    algorithm_version text NOT NULL,
    config_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    analysis_config_id uuid NOT NULL REFERENCES analysis_configs(id) ON DELETE RESTRICT,
    input_game_set_hash text NOT NULL,
    stage text NOT NULL,
    status text NOT NULL CHECK (status IN (
        'queued', 'running', 'stopping', 'succeeded', 'failed', 'cancelled'
    )),
    completed_work integer NOT NULL DEFAULT 0 CHECK (completed_work >= 0),
    total_work integer NOT NULL DEFAULT 0 CHECK (total_work >= 0),
    lease_owner text,
    lease_expires_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_error text,
    cancellation_requested boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_one_active_target
ON analysis_jobs (player_id, analysis_config_id, input_game_set_hash)
WHERE status IN ('queued', 'running', 'stopping');

CREATE TABLE IF NOT EXISTS job_subscribers (
    job_id uuid NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'inactive')),
    notify_when_ready boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, account_id)
);

CREATE TABLE IF NOT EXISTS move_analyses (
    game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply integer NOT NULL CHECK (ply > 0),
    analysis_config_id uuid NOT NULL REFERENCES analysis_configs(id) ON DELETE RESTRICT,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (game_id, ply, analysis_config_id)
);

CREATE TABLE IF NOT EXISTS derived_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
    artifact_type text NOT NULL,
    dependency_hash text NOT NULL,
    schema_version text NOT NULL,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        player_id, account_id, artifact_type, dependency_hash, schema_version
    )
);

CREATE TABLE IF NOT EXISTS puzzle_reviews (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    puzzle_id text NOT NULL,
    review_state jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, puzzle_id)
);

CREATE TABLE IF NOT EXISTS stripe_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    event_created_at timestamptz NOT NULL,
    processing_status text NOT NULL
        CHECK (processing_status IN ('processing', 'processed', 'failed')),
    failure_details text,
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('account', 'system', 'admin')),
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'accounts', 'subscriptions', 'players', 'account_profiles', 'games',
        'analysis_jobs', 'job_subscribers', 'move_analyses',
        'derived_artifacts', 'puzzle_reviews'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', table_name);
        EXECUTE format(
            'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            table_name
        );
    END LOOP;
END;
$$;
