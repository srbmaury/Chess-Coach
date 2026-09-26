-- pgTAP allow/deny checks for browser-coordinated analysis.
-- Run against a disposable Supabase database with the hosted migrations applied:
--   supabase test db            (with this file under supabase/tests), or
--   psql "$DATABASE_URL" -f tests/sql/browser_analysis_rls.test.sql
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(16);

INSERT INTO accounts (id, email) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.test'),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'b@example.test');
INSERT INTO players (id, canonical_username, display_username) VALUES
    ('bbbbbbbb-0000-0000-0000-000000000001', 'rls-player-a', 'Player A'),
    ('bbbbbbbb-0000-0000-0000-000000000002', 'rls-player-b', 'Player B');
INSERT INTO account_profiles (account_id, player_id, slot_type) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'free'),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'free');
INSERT INTO analysis_configs (id, stockfish_version, depth, thresholds, algorithm_version, config_hash)
VALUES ('cccccccc-0000-0000-0000-000000000001', '19', 12, '{}', '1', 'rls-config');
INSERT INTO analysis_jobs (id, player_id, analysis_config_id, input_game_set_hash, stage, status, total_work)
VALUES ('dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        'cccccccc-0000-0000-0000-000000000001', 'rls-games', 'analyze', 'queued', 3);
INSERT INTO job_subscribers (job_id, account_id, state) VALUES
    ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'active');
INSERT INTO derived_artifacts (player_id, artifact_type, dependency_hash, schema_version,
                               storage_bucket, storage_key, status)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'report', 'rls-dep', '1', 'bucket', 'rls-key', 'ready');

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.analysis_checkpoints'::regclass),
    'analysis_checkpoints has RLS enabled'
);
SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.analysis_upload_grants'::regclass),
    'analysis_upload_grants has RLS enabled'
);

-- anon -----------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT throws_ok('SELECT 1 FROM public.analysis_jobs', '42501', NULL, 'anon cannot read jobs');
SELECT throws_ok('SELECT 1 FROM public.players', '42501', NULL, 'anon cannot read players');
SELECT throws_ok('SELECT 1 FROM public.derived_artifacts', '42501', NULL, 'anon cannot read artifacts');
RESET ROLE;

-- subscribed, entitled account --------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM public.analysis_jobs', ARRAY[1], 'subscriber reads its job');
SELECT results_eq('SELECT count(*)::int FROM public.job_subscribers', ARRAY[1], 'subscriber reads own subscription');
SELECT results_eq('SELECT count(*)::int FROM public.derived_artifacts', ARRAY[1], 'entitled account reads shared artifacts');
SELECT throws_ok('SELECT lease_token_digest FROM public.analysis_jobs', '42501', NULL, 'lease digest is not readable');
SELECT throws_ok(
    $$UPDATE public.analysis_jobs SET status = 'succeeded'$$, '42501', NULL, 'browser cannot update jobs'
);
SELECT throws_ok(
    $$DELETE FROM public.job_subscribers$$, '42501', NULL, 'browser cannot delete subscriptions'
);
SELECT throws_ok(
    $$INSERT INTO public.analysis_checkpoints (job_id, sequence, storage_bucket, storage_key, byte_size,
        content_hash, result_count, first_unit, last_unit, first_game_id, last_game_id,
        analysis_config_hash, engine_build_hash, uploader_device_id)
      VALUES ('dddddddd-0000-0000-0000-000000000001', 1, 'b', 'k', 1, repeat('a', 64), 0, 0, 0,
        'g', 'g', 'c', 'e', 'd')$$,
    '42501', NULL, 'browser cannot insert checkpoints'
);
RESET ROLE;

-- unrelated account -------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM public.analysis_jobs', ARRAY[0], 'unrelated account sees no job');
SELECT results_eq('SELECT count(*)::int FROM public.derived_artifacts', ARRAY[0], 'unentitled account sees no artifacts');
SELECT results_eq('SELECT count(*)::int FROM public.players', ARRAY[1], 'account sees only its own player');
RESET ROLE;

-- stopped subscriber --------------------------------------------------------------
UPDATE job_subscribers SET state = 'stopped';
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM public.analysis_jobs', ARRAY[0], 'stopped subscriber no longer reads job progress');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
