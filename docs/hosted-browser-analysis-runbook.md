# Hosted browser analysis runbook

Operators use this to turn on browser-coordinated shared analysis. Merging code changes
nothing in production: every step below is an explicit action.

## 0. Prerequisites

- A Supabase project with Auth (magic links), Postgres, Storage, and Realtime.
- The project uses the legacy HS256 JWT secret (see README, *Hosted authentication*).
- API keys from **Settings → API Keys**:
  - `sb_publishable_…`: safe for browsers.
  - `sb_secret_…`: server only. Never paste it into client code, logs, issues, or
    `render.yaml`.

- **Auth → URL Configuration**:
  - Set **Site URL** to the public app URL (for example
    `https://chess-ml-coach.onrender.com`). Otherwise magic links point at Supabase's
    default `http://localhost:3000`.
  - Add the same origin under **Redirect URLs**, plus `http://127.0.0.1:8000` for local
    testing. The app asks Supabase to return users to the page they signed in from, and
    Supabase only honours listed URLs.

## 1. Database migrations

```bash
export CHESS_COACH_PERSISTENCE_MODE=hosted
export DATABASE_URL='postgresql://…'   # connection string, from the dashboard
chess-coach db-migrate                 # applies 0001, 0002; safe to repeat
```

`0002_browser_analysis` adds lease/checkpoint/upload-grant tables, revokes default
`anon`/`authenticated` table privileges, enables RLS on every table, and grants
column-limited, RLS-filtered reads to `authenticated`. Browsers get no writes.

**Enable Realtime before migrating.** The private Broadcast policy on
`realtime.messages` is created only if that table exists. If you enabled Realtime
afterwards, re-run the `chess_job_progress_receive` block from the migration in the SQL
editor. Verify:

```sql
select policyname from pg_policies where schemaname = 'realtime' and tablename = 'messages';
```

### Verify grants and RLS

Run the pgTAP suite against a disposable copy (never production data):

```bash
psql "$DISPOSABLE_DATABASE_URL" -f tests/sql/browser_analysis_rls.test.sql   # all 16 "ok"
CHESS_COACH_TEST_DATABASE_URL=… CHESS_COACH_TEST_DATABASE_ADMIN_URL=… .venv/bin/pytest -q
```

The live Python suite drops and recreates hosted tables. Point it only at a throwaway
database such as `docker run -p 54329:5432 -e POSTGRES_PASSWORD=postgres
public.ecr.aws/supabase/postgres:17.6.1.167`.

## 2. Storage bucket

Create a **private** bucket named `analysis-artifacts` (or set
`SUPABASE_STORAGE_BUCKET`):

- Public: **off**. Add **no** Storage RLS policies for `anon`/`authenticated`; all access
  goes through short-lived signed URLs issued by the server.
- File size limit: `8 MB` (matches `max_upload_bytes`).
- Allowed MIME types: `application/gzip`.

Objects are immutable and content-addressed:

- `players/<player>/manifests/<hash>.json.gz`: canonical game lists.
- `jobs/<job>/checkpoints/<config>/<seq>-<hash>.json.gz`: move analysis.
- `players/<player>/artifacts/<type>/<dependency>-<hash>.json.gz`: results.

### Orphan cleanup

Uploads that were granted but never finalized stay unpublished. Remove them
periodically (for example, a daily cron job):

```python
from chess_ml_coach.config import get_settings
from chess_ml_coach.hosted.database import Database
from chess_ml_coach.web.hosted_analysis_routes import build_hosted_analysis

settings = get_settings()
database = Database.from_settings(settings); database.open()
print(build_hosted_analysis(settings, database).checkpoints.cleanup_orphans())
```

## 3. Render configuration

Set these in the Render dashboard (never in `render.yaml`):

| Variable | Value |
| --- | --- |
| `CHESS_COACH_PERSISTENCE_MODE` | `hosted` |
| `DATABASE_URL` | Supabase Postgres connection string |
| `SUPABASE_JWT_SECRET` | legacy JWT secret |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` |
| `INSTALL_NATIVE_STOCKFISH` | `false` (Docker build arg; drops the engine binary) |
| `CHESS_COACH_HOSTED_BROWSER_ANALYSIS_ENABLED` | leave `false` until step 4 |

In hosted mode the server builds no pipeline manager or native engine, serves no local
artifact, profile, or adaptive routes (`404`), and writes nothing below `data/` or
`models/` (`tests/test_hosted_stateless_runtime.py`). Leaving the build arg at its
default `true` keeps the existing local-mode deployment working unchanged.

Rate limits are held in memory, which is correct for a single instance. Supply a shared
`RateLimiter` before scaling out.

## 4. Staged rollout

1. **Shadow.** Deploy with the flag `false`. Check `/api/hosted/config`: it should show
   `analysis_enabled: false` and no secrets.
2. **Canary.** Set the flag to `true` on a staging service used only by test accounts.
   Run two browsers on the same player: one job, one lease, the second browser shows
   "Another browser is analyzing". Close the worker tab: after about 60 s the second
   browser resumes from the checkpoint. Stop following in one browser: the other
   continues. Finish a small player and confirm another account gets results
   immediately.
3. **Production.** Enable the flag and watch `audit_events` (`lease_takeover`),
   upload-grant growth, and error rates.

## 5. Rollback and quarantine

- **Disable:** set the flag to `false`. Analysis routes answer `503`; completed results
  stay readable.
- **Quarantine a bad configuration:**
  `update analysis_configs set quarantined_at = now() where config_hash = '…';`. New
  jobs are refused and its artifacts are hidden.
- **Quarantine one artifact:**
  `update derived_artifacts set quarantined_at = now() where id = '…';`
- Nothing is deleted. Subscriptions and unrelated results are untouched.

## 6. Provenance and trust

Every hosted result has `compute_source = 'community_computed'`. The server checks
lease ownership, sequence, size, hash, gzip bounds, game identity, the exact set of the
player's moves, and move legality. It cannot tell a plausible fabricated engine score
from a real one. A future server-verified tier can recompute and mark results
`server_verified` without changing artifact identities.

## 7. Browser requirements

WebAssembly, Web Workers, IndexedDB, CompressionStream/DecompressionStream, and Web
Crypto. Unsupported browsers, phones, data-saver mode, and low-memory devices observe
only. The browser caps its own cache at 256 MiB, and a Web Lock keeps one tab per
device computing a given job.
