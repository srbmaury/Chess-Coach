# Browser-Coordinated Shared Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all hosted chess computation into a resumable browser worker while Supabase coordinates one shared worker lease and stores durable results, leaving Render stateless and preserving local Python workflows.

**Architecture:** FastAPI remains the authenticated authority for entitlements, job/lease transitions, validation, and signed artifact URLs. React uses a dedicated Stockfish 19 lite single-threaded WASM Web Worker, IndexedDB checkpoints, and private Supabase Realtime updates; immutable results upload directly to Supabase Storage. The rollout stays feature-flagged until browser output matches the current Python pipeline fixtures.

**Tech Stack:** Python 3.11, FastAPI, psycopg 3/PostgreSQL 15+, React 19, TypeScript 5.9, Vite 8, Vitest 5, `@supabase/supabase-js` 2.117.1, `idb` 8.0.3, `stockfish` 19.0.0 lite single-threaded WASM, `chess.js` 1.4.0.

**Spec:** `docs/superpowers/specs/2026-09-26-browser-coordinated-analysis-design.md`

## Global Constraints

- Hosted Render must never launch Stockfish or persist PGNs, checkpoints, models, reports, or analysis artifacts to its filesystem.
- Local Python CLI and local web workflows keep native Stockfish and filesystem persistence without requiring Supabase.
- The shared job identity is `(player_id, input_game_set_hash, analysis_config_hash)` and permits at most one non-terminal job and one valid worker lease.
- Lease duration is 60 seconds and the browser renews every 20 seconds using PostgreSQL server time.
- Browser-computed results are labelled `community_computed`; no code may present them as server-verified.
- Browser clients receive only Supabase URL and publishable key. Service-role/secret keys remain server-only and are never logged or returned.
- All public-schema tables use explicit grants and RLS. Privileged mutation functions, if required, live outside exposed schemas, use a fixed `search_path`, verify `auth.uid()`, and have narrowly granted execution.
- No custom objects are created in the locked `realtime` schema.
- Direct uploads use immutable keys, strict compressed/decompressed size limits, and short-lived object-scoped signed URLs.
- Package versions and lockfiles are committed. Stockfish GPLv3 attribution and source-offer obligations are documented.
- Production Supabase schema, Storage buckets, Render variables, and feature flags are not changed by merging code; activation is a separate explicit deployment step.

## Review Focus

- Two simultaneous create/claim requests must return one job and exactly one lease; Task 4 adds concurrency contract tests.
- A stale browser must be unable to renew or finalize after lease takeover; Tasks 4 and 6 add stale-token tests.
- An interrupted direct upload must not advance durable progress or become visible as ready; Task 6 tests orphan and hash-mismatch paths.
- Browser refresh/offline recovery must resume only from the latest server-acknowledged sequence and terminate compute on lease loss; Tasks 5 and 7 test these paths.
- Hosted mode must perform no native Stockfish launch or artifact filesystem write even on errors; Task 10 adds deployment regression tests.

---

### Task 1: Add hosted browser configuration and authenticated frontend bootstrap

**Files:**
- Modify: `src/chess_ml_coach/config.py`
- Modify: `src/chess_ml_coach/web/schemas.py`
- Modify: `src/chess_ml_coach/web/hosted_routes.py`
- Modify: `src/chess_ml_coach/web/app.py`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/hosted/config.ts`
- Create: `web/src/hosted/auth.ts`
- Test: `tests/test_hosted_browser_config.py`
- Test: `web/src/hosted/config.test.ts`
- Test: `web/src/hosted/auth.test.ts`

**Interfaces:**
- Consumes: `Settings.is_hosted`, `require_account(request) -> Account`.
- Produces: `GET /api/hosted/config -> HostedBrowserConfig`; `getHostedConfig(): Promise<HostedBrowserConfig>`; `createHostedClient(config): SupabaseClient`; `requestMagicLink(email): Promise<void>`; `observeSession(callback): Unsubscribe`; `authorizedFetch(session, input, init)`.

- [ ] **Step 1: Write failing backend tests for public configuration**

Assert local mode returns `{hosted: false}` with no Supabase values; hosted mode returns only `supabase_url`, `supabase_publishable_key`, `analysis_enabled`, engine/config versions, lease/renew intervals, and upload limits. Assert database URLs, JWT secrets, and service keys never appear.

- [ ] **Step 2: Run the backend tests and verify the route/schema are missing**

Run: `.venv/bin/pytest tests/test_hosted_browser_config.py -q`

- [ ] **Step 3: Add exact settings and config endpoint**

Add nullable `supabase_url`, nullable `supabase_publishable_key`, and `hosted_browser_analysis_enabled: bool = False`; hosted browser analysis validates both public values while ordinary hosted persistence remains usable without enabling it. Add `HostedBrowserConfig` and the unauthenticated read-only config route.

- [ ] **Step 4: Write failing frontend tests for config, session propagation, and missing configuration**

Pin `@supabase/supabase-js` to `2.117.1`. Assert one client instance, normalized email magic-link request, callback-session recovery, logout, bearer-token attachment, refreshed-session use, generic auth failure messages, and no secret-shaped value in thrown errors.

- [ ] **Step 5: Implement frontend bootstrap and run focused suites**

Run: `.venv/bin/pytest tests/test_hosted_browser_config.py -q`

Run: `cd web && npm test -- --run src/hosted/config.test.ts src/hosted/auth.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/chess_ml_coach/config.py src/chess_ml_coach/web/schemas.py src/chess_ml_coach/web/hosted_routes.py src/chess_ml_coach/web/app.py tests/test_hosted_browser_config.py web/package.json web/package-lock.json web/src/hosted
git commit -m "feat: bootstrap hosted browser analysis"
```

---

### Task 2: Migrate the shared schema for browser leases, checkpoints, grants, and RLS

**Files:**
- Create: `src/chess_ml_coach/hosted/sql/0002_browser_analysis.sql`
- Modify: `tests/test_hosted_migrations.py`
- Create: `tests/test_browser_analysis_schema.py`
- Create: `tests/sql/browser_analysis_rls.test.sql`

**Interfaces:**
- Consumes: migration discovery/application from `hosted.migrations`; existing hosted tables.
- Produces: browser lease columns/statuses; `analysis_checkpoints`; indexes, grants, RLS policies, and Storage object metadata boundaries consumed by Tasks 3-6.

- [ ] **Step 1: Write failing migration contract tests**

Assert migration order `0001`, `0002`; `paused` subscriber/job states; lease digest/account/device/expiry/heartbeat; checkpoint sequence/hash/size/cursors; `community_computed`; partial unique job index includes queued/running/paused; policy-filter columns are leading indexed columns; SQL contains no transaction control and no custom `realtime.*` object creation.

- [ ] **Step 2: Run schema tests and verify failure**

Run: `.venv/bin/pytest tests/test_hosted_migrations.py tests/test_browser_analysis_schema.py -q`

- [ ] **Step 3: Implement the migration**

Use additive columns/tables and constraint replacement so existing rows migrate safely. Revoke default `anon`/`authenticated` table privileges, grant only required reads, enable RLS, and define account-entitlement/subscription read policies. Add a public-schema job-change trigger that calls `realtime.broadcast_changes()` on private topic `job:<job_id>`, plus a narrowly scoped policy on `realtime.messages` that permits receive access only when `auth.uid()` has an active matching subscription. Do not grant browser writes to authoritative job or checkpoint tables and do not create or alter objects in the locked `realtime` schema except the supported authorization policy.

- [ ] **Step 4: Add pgTAP allow/deny cases**

Cover anon denial; authenticated account access to its subscription/job; denial of unrelated jobs/private artifacts; denial of direct insert/update/delete; private Broadcast receipt for subscribers; and Broadcast denial after stop. Keep the SQL test runnable with `supabase test db` when a local Supabase stack is available.

- [ ] **Step 5: Verify migration contracts and repeatability**

Run: `.venv/bin/pytest tests/test_hosted_migrations.py tests/test_browser_analysis_schema.py -q`

Run when Supabase CLI is available: `supabase test db`

- [ ] **Step 6: Commit**

```bash
git add src/chess_ml_coach/hosted/sql/0002_browser_analysis.sql tests/test_hosted_migrations.py tests/test_browser_analysis_schema.py tests/sql/browser_analysis_rls.test.sql
git commit -m "feat: add browser analysis coordination schema"
```

---

### Task 3: Add account profile entitlements and canonical game manifests

**Files:**
- Create: `src/chess_ml_coach/hosted/profiles.py`
- Create: `src/chess_ml_coach/hosted/manifests.py`
- Modify: `src/chess_ml_coach/chesscom.py`
- Create: `tests/test_hosted_profiles.py`
- Create: `tests/test_hosted_manifests.py`

**Interfaces:**
- Consumes: `Database.transaction()`, authenticated `Account`, existing `accounts/players/account_profiles/games/player_games/subscriptions` tables.
- Produces: `ProfileRepository.claim(account_id, username) -> AccountProfile`; `ProfileRepository.require_entitled(account_id, player_id) -> Player`; `ManifestService.build(player) -> GameManifest`; `GameManifest.hash`, `.games`, `.storage_key`.

- [ ] **Step 1: Write failing entitlement tests**

Cover immutable first free profile, duplicate same-player idempotency, five paid slots only for active/trialing subscription, sixth paid rejection, inactive paid profile read-only behavior, and transaction/concurrency enforcement.

- [ ] **Step 2: Implement profile repository minimally and verify**

Run: `.venv/bin/pytest tests/test_hosted_profiles.py -q`

- [ ] **Step 3: Write failing canonical manifest tests**

Assert normalized username, stable Chess.com player ID preference, deterministic game ordering/hash independent of API month order, PGN hash deduplication, legal-PGN rejection, bounded response size, serial retry behavior, and no Render filesystem writes.

- [ ] **Step 4: Implement streaming/in-memory manifest service**

Reuse Chess.com parsing but return bounded immutable values. The server may stream Chess.com data or canonical Storage objects; it must not create local artifact files.

- [ ] **Step 5: Run focused and regression tests**

Run: `.venv/bin/pytest tests/test_hosted_profiles.py tests/test_hosted_manifests.py tests/test_chesscom.py -q`

- [ ] **Step 6: Commit**

```bash
git add src/chess_ml_coach/hosted/profiles.py src/chess_ml_coach/hosted/manifests.py src/chess_ml_coach/chesscom.py tests/test_hosted_profiles.py tests/test_hosted_manifests.py
git commit -m "feat: add hosted profile manifests"
```

---

### Task 4: Implement atomic shared-job and lease coordination

**Files:**
- Create: `src/chess_ml_coach/hosted/jobs.py`
- Create: `src/chess_ml_coach/hosted/leases.py`
- Create: `tests/test_hosted_jobs.py`
- Create: `tests/test_hosted_leases.py`

**Interfaces:**
- Consumes: entitled `Player`, `GameManifest.hash`, standard analysis config hash, `Database.transaction()`.
- Produces: `JobRepository.create_or_join(...) -> SharedJob`; `stop_observing(job_id, account_id)`; `LeaseService.claim(...) -> LeaseGrant`; `renew(...) -> LeaseGrant`; `release(...)`; `LeaseLostError`.

- [ ] **Step 1: Write failing create/join tests**

Cover completed-result reuse; one active job under simultaneous calls; subscriber upsert/reactivation; stopped subscriber isolation; no-subscriber paused state; and sanitized repository errors.

- [ ] **Step 2: Implement job repository with row locking and unique-conflict recovery**

Run: `.venv/bin/pytest tests/test_hosted_jobs.py -q`

- [ ] **Step 3: Write failing lease-state tests**

Assert 60-second expiry from database time, 20-second client renewal contract, one winner under simultaneous claims, same owner idempotency, expired takeover, stale token denial, digest-only persistence, stop-observing release, and observer-only capability rejection.

- [ ] **Step 4: Implement lease service**

Use 32-byte random tokens, SHA-256 digests, constant-time token comparison where comparison occurs in Python, row locks, and database `now()`. Never include account/device IDs in public job views.

- [ ] **Step 5: Run focused and full Python tests**

Run: `.venv/bin/pytest tests/test_hosted_jobs.py tests/test_hosted_leases.py -q`

Run: `.venv/bin/pytest -q`

- [ ] **Step 6: Commit**

```bash
git add src/chess_ml_coach/hosted/jobs.py src/chess_ml_coach/hosted/leases.py tests/test_hosted_jobs.py tests/test_hosted_leases.py
git commit -m "feat: coordinate shared browser leases"
```

---

### Task 5: Expose authenticated profile, job, lease, and manifest APIs

**Files:**
- Create: `src/chess_ml_coach/web/hosted_analysis_routes.py`
- Create: `src/chess_ml_coach/web/hosted_analysis_schemas.py`
- Modify: `src/chess_ml_coach/web/app.py`
- Modify: `src/chess_ml_coach/web/serve.py`
- Create: `tests/test_hosted_analysis_api.py`
- Create: `tests/test_hosted_analysis_authorization.py`

**Interfaces:**
- Consumes: Task 3 repositories/manifests, Task 4 jobs/leases, `require_account`.
- Produces: `POST/GET /api/hosted/profiles`; `/api/hosted/jobs`; `/api/hosted/jobs/{id}`; `/subscribe`; `/stop`; `/lease/claim`; `/lease/renew`; `/lease/release`; `/manifest`.

- [ ] **Step 1: Write failing happy-path API tests**

Pin request/response schemas, `ready` reuse, create/join, observer status, lease grant/renew/release, and manifest download including ETag/config hashes.

- [ ] **Step 2: Write failing authorization and abuse tests**

Cover missing/expired token, unentitled profile, another account's stopped subscription, another device's lease, unknown IDs, oversized body, malformed device ID, forged account ID, and secret/error redaction.

- [ ] **Step 3: Implement routes and dependency injection**

Keep routers thin; all state transitions live in repositories/services. Apply per-account/IP rate-limit seams with an in-memory test implementation and a replaceable production protocol.

- [ ] **Step 4: Verify API tests and OpenAPI generation**

Run: `.venv/bin/pytest tests/test_hosted_analysis_api.py tests/test_hosted_analysis_authorization.py -q`

Run: `.venv/bin/python -c "from chess_ml_coach.web.app import create_app; create_app().openapi()"`

- [ ] **Step 5: Commit**

```bash
git add src/chess_ml_coach/web/hosted_analysis_routes.py src/chess_ml_coach/web/hosted_analysis_schemas.py src/chess_ml_coach/web/app.py src/chess_ml_coach/web/serve.py tests/test_hosted_analysis_api.py tests/test_hosted_analysis_authorization.py
git commit -m "feat: expose hosted analysis coordination api"
```

---

### Task 6: Add direct Supabase artifact uploads and checkpoint finalization

**Files:**
- Create: `src/chess_ml_coach/hosted/storage.py`
- Create: `src/chess_ml_coach/hosted/checkpoints.py`
- Modify: `src/chess_ml_coach/web/hosted_analysis_routes.py`
- Modify: `src/chess_ml_coach/web/hosted_analysis_schemas.py`
- Create: `tests/test_hosted_storage.py`
- Create: `tests/test_hosted_checkpoints.py`
- Create: `tests/test_hosted_checkpoint_api.py`

**Interfaces:**
- Consumes: valid `LeaseGrant`, Task 2 `analysis_checkpoints`, immutable Storage bucket.
- Produces: `ArtifactStorage.create_upload(job_id, sequence, size, sha256) -> SignedUpload`; `CheckpointService.finalize(...) -> Checkpoint`; `/uploads`; `/checkpoints/finalize`; `/complete`.

- [ ] **Step 1: Write failing signed-upload tests**

Assert object key includes job/config/sequence/hash; expiry is five minutes; content type and compressed size are fixed; no list/cross-job permission; service key and signed token are redacted from logs/errors.

- [ ] **Step 2: Implement Storage protocol and Supabase HTTP adapter**

Use an injectable HTTP client and no local temporary files. Validate current Supabase signed-upload response semantics through adapter contract tests rather than leaking provider shapes into routes.

- [ ] **Step 3: Write failing checkpoint/finalization tests**

Cover expected sequence, duplicate idempotency, skipped/replayed sequence, stale lease, wrong hash/size/config/game/ply, illegal move, decompression limit, missing object, orphan non-publication, monotonic counters, and final completion coverage.

- [ ] **Step 4: Implement checkpoint service and routes**

Finalize only after object metadata/hash and bounded decompression validation; insert checkpoint and advance job in one transaction. Completion requires exact unit coverage and immutable derived-artifact dependencies.

- [ ] **Step 5: Run focused and full Python tests**

Run: `.venv/bin/pytest tests/test_hosted_storage.py tests/test_hosted_checkpoints.py tests/test_hosted_checkpoint_api.py -q`

Run: `.venv/bin/pytest -q`

- [ ] **Step 6: Commit**

```bash
git add src/chess_ml_coach/hosted/storage.py src/chess_ml_coach/hosted/checkpoints.py src/chess_ml_coach/web/hosted_analysis_routes.py src/chess_ml_coach/web/hosted_analysis_schemas.py tests/test_hosted_storage.py tests/test_hosted_checkpoints.py tests/test_hosted_checkpoint_api.py
git commit -m "feat: persist browser analysis checkpoints"
```

---

### Task 7: Build the browser coordinator and IndexedDB resume store

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/hosted/types.ts`
- Create: `web/src/hosted/api.ts`
- Create: `web/src/hosted/device.ts`
- Create: `web/src/hosted/checkpointStore.ts`
- Create: `web/src/hosted/coordinator.ts`
- Test: `web/src/hosted/checkpointStore.test.ts`
- Test: `web/src/hosted/coordinator.test.ts`

**Interfaces:**
- Consumes: Task 5/6 APIs and config; browser `Worker` factory.
- Produces: `CheckpointStore`; `AnalysisCoordinator.start(jobId)`; `.stopObserving()`; `.dispose()`; typed coordinator events.

- [ ] **Step 1: Pin `idb` and write failing resume-store tests**

Assert database name/version, per-job manifest isolation, acknowledged vs unacknowledged batches, canonical sequence ordering, refresh recovery, corrupt-record discard, quota failure message, and cleanup after completion.

- [ ] **Step 2: Implement `CheckpointStore`**

Pin `idb` to `8.0.3`; keep serialization versioned and never store access or lease tokens persistently.

- [ ] **Step 3: Write failing coordinator tests with fake timers and fake worker**

Cover capability/observer-only path, claim, renew every 20 seconds, no overlapping renewals, visibility changes, offline pause, upload/finalize acknowledgement, refresh resume, stop-observing release, lease-loss immediate worker termination, expired takeover, and page disposal best-effort release.

- [ ] **Step 4: Implement coordinator state machine**

Allowed states: `idle`, `observing`, `claiming`, `running`, `uploading`, `paused`, `lease_lost`, `succeeded`, `failed`, `stopped`. Serialize transitions and ignore stale async completions by generation ID.

- [ ] **Step 5: Run frontend tests and build**

Run: `cd web && npm test -- --run src/hosted/checkpointStore.test.ts src/hosted/coordinator.test.ts`

Run: `cd web && npm run build`

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/hosted
git commit -m "feat: coordinate resumable browser analysis"
```

---

### Task 8: Integrate Stockfish 19 WASM in a dedicated Web Worker

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/engine/protocol.ts`
- Create: `web/src/engine/uci.ts`
- Create: `web/src/engine/stockfish.worker.ts`
- Create: `web/src/engine/workerClient.ts`
- Create: `web/src/engine/fakeEngine.ts`
- Test: `web/src/engine/uci.test.ts`
- Test: `web/src/engine/workerClient.test.ts`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: `GameManifest`, coordinator unit requests/cancellation.
- Produces: `EngineWorkerClient.analyze(unit, signal) -> MoveAnalysis`; deterministic `engineBuildHash`; progress/batch events.

- [ ] **Step 1: Pin Stockfish assets and write failing UCI parser tests**

Pin `stockfish` to `19.0.0` and select `stockfish-19-lite-single` assets. Cover centipawn/mate scores, bound flags, MultiPV, promotion, terminal/no-move positions, malformed lines, and deterministic best-line normalization.

- [ ] **Step 2: Implement typed UCI protocol/parser**

Use integer centipawns, explicit mate representation, UCI moves, depth, nodes, and principal variation. No DOM imports in engine modules.

- [ ] **Step 3: Write failing worker-client tests**

Use a deterministic fake UCI worker. Cover `uci`/`isready` handshake, one search at a time, stop/abort, worker crash, timeout, lease-loss termination, batch progress, and stale-message isolation.

- [ ] **Step 4: Implement Stockfish Web Worker and Vite asset packaging**

Copy immutable JS/WASM assets into the production bundle with hashed URLs. Verify hosted Docker contains web assets but no native Stockfish package/binary; local Python image behavior remains explicitly documented if a separate local image target is retained.

- [ ] **Step 5: Run tests, build, and asset/license checks**

Run: `cd web && npm test -- --run src/engine/uci.test.ts src/engine/workerClient.test.ts`

Run: `cd web && npm run build`

Run: `rg -n "stockfish-19-lite-single|GPL" web/package-lock.json README.md Dockerfile`

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/engine Dockerfile README.md
git commit -m "feat: run stockfish analysis in browser"
```

---

### Task 9: Port derived features, puzzles, model summaries, and reports with parity fixtures

**Files:**
- Create: `web/src/analysis/classify.ts`
- Create: `web/src/analysis/features.ts`
- Create: `web/src/analysis/puzzles.ts`
- Create: `web/src/analysis/model.ts`
- Create: `web/src/analysis/report.ts`
- Create: `web/src/analysis/pipeline.ts`
- Create: `web/src/analysis/parity.test.ts`
- Create: `tests/fixtures/browser_parity.json`
- Create: `tests/test_browser_parity_fixture.py`

**Interfaces:**
- Consumes: Task 8 `MoveAnalysis[]`, canonical games, existing Python thresholds/feature definitions.
- Produces: versioned `analysis`, `features`, `puzzles`, `model_summary`, and `report` artifact payloads plus dependency hashes.

- [ ] **Step 1: Generate and lock a Python parity fixture**

Use existing PGN fixtures and deterministic stored engine results. Assert Python emits the committed canonical JSON without timestamps/platform paths and that fixture generation never calls a live engine.

- [ ] **Step 2: Write failing TypeScript parity tests**

Assert exact classification labels/reasons, feature values and grouping, puzzle IDs/motifs/difficulty, model summary coefficients/metrics under a deterministic lightweight algorithm, report sections, stable hashes, empty/small-group behavior, mate scores, and malformed inputs.

- [ ] **Step 3: Implement pure TypeScript derived modules**

Port behavior, not Python storage formats. Keep each module pure and version every output schema/algorithm. No network, DOM, Supabase, or IndexedDB imports.

- [ ] **Step 4: Connect derived stages to the browser pipeline**

Emit bounded artifacts through Task 7/6 checkpoint interfaces. A failed derived stage retains acknowledged move analysis and resumes independently.

- [ ] **Step 5: Verify cross-language parity**

Run: `.venv/bin/pytest tests/test_browser_parity_fixture.py -q`

Run: `cd web && npm test -- --run src/analysis/parity.test.ts`

Run: `cd web && npm run build`

- [ ] **Step 6: Commit**

```bash
git add web/src/analysis tests/fixtures/browser_parity.json tests/test_browser_parity_fixture.py
git commit -m "feat: build derived analysis in browser"
```

---

### Task 10: Add shared progress, takeover, result navigation, and Realtime fallback UX

**Files:**
- Create: `web/src/hosted/realtime.ts`
- Create: `web/src/hosted/HostedAnalysis.tsx`
- Create: `web/src/hosted/HostedAnalysis.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/LegacyApp.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: auth/config, Task 7 coordinator events, Supabase private Broadcast, Task 5 job polling/results.
- Produces: hosted onboarding/profile cards; worker/observer progress; stop-observing; takeover/resume; ready navigation.

- [ ] **Step 1: Write failing Realtime/polling tests**

Assert private topic naming, JWT refresh propagation, reconnect, event deduplication, out-of-order event rejection, polling fallback, and revoked-subscription behavior. Realtime is an optimization; polling must converge to server state.

- [ ] **Step 2: Implement Realtime adapter**

Subscribe only after authorization and unsubscribe on account/job change. Never place account email, device ID, or lease token in topic names or messages.

- [ ] **Step 3: Write failing hosted flow component tests**

Cover signed-out magic-link form/callback/error/logout, one free profile, paid-slot messaging, existing-ready reuse, “Another browser is analyzing,” worker capability opt-out, lease takeover, refresh resume, stop semantics, completed feature navigation after stopping, community-computed badge, unsupported browser, offline/quota/worker crash errors, and no normal hosted Pipeline page.

- [ ] **Step 4: Implement hosted flow and preserve local UI**

Select hosted/local shell using public config. Local mode continues rendering existing profile controls and pipeline unchanged.

- [ ] **Step 5: Run frontend suite and build**

Run: `cd web && npm test -- --run`

Run: `cd web && npm run build`

- [ ] **Step 6: Commit**

```bash
git add web/src/hosted/realtime.ts web/src/hosted/HostedAnalysis.tsx web/src/hosted/HostedAnalysis.test.tsx web/src/App.tsx web/src/LegacyApp.tsx web/src/styles.css
git commit -m "feat: add shared browser analysis experience"
```

---

### Task 11: Prove stateless Render behavior and document staged activation

**Files:**
- Modify: `render.yaml`
- Modify: `Dockerfile`
- Modify: `README.md`
- Create: `docs/hosted-browser-analysis-runbook.md`
- Create: `tests/test_hosted_stateless_runtime.py`
- Create: `web/src/HostedAnalysisE2E.test.tsx`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: disabled-by-default deploy configuration, operator migration/bucket/RLS/rollout steps, final verification evidence.

- [ ] **Step 1: Write failing stateless-host regression tests**

Assert hosted startup never constructs `PipelineManager` with writable hosted profile paths, never invokes native engine factories, never writes below `data/` or `models/`, rejects oversized streamed inputs before buffering, and local mode still performs its established behavior.

- [ ] **Step 2: Make local pipeline construction conditional on local mode**

Change `create_app()` and `serve()` so `PipelineManager` and native engine dependencies are constructed only when `Settings.is_hosted` is false. Hosted legacy pipeline routes return `404`; hosted analysis routes remain available. Keep the browser-analysis feature flag false in committed Render configuration.

- [ ] **Step 3: Add end-to-end fake-engine scenarios**

Cover two accounts joining one job/one lease, first tab closing, second taking over from acknowledged sequence, first stale finalization rejected, one subscriber stopping without blocking the other, result reuse, and observer-only browser behavior.

- [ ] **Step 4: Write runbook and README**

Document migrations, explicit grants/RLS tests, Storage bucket/lifecycle rules, publishable vs secret keys, private Broadcast setup, feature-flag canary, rollback, orphan cleanup, provenance, browser requirements, GPL attribution/source offer, and the fact that merging does not deploy or enable production.

- [ ] **Step 5: Run complete verification**

Run: `.venv/bin/ruff check src tests`

Run: `.venv/bin/pytest -q`

Run: `cd web && npm test -- --run`

Run: `cd web && npm run build`

Run: `git diff --check`

Run: `rg -n "service_role|SUPABASE_SERVICE|postgresql://[^.].+@|lease_token" src web tests README.md docs/hosted-browser-analysis-runbook.md`

Expected: all tests/builds pass; matches are declarations/test fixtures only, never real secrets or browser-exposed values.

- [ ] **Step 6: Commit**

```bash
git add render.yaml Dockerfile README.md docs/hosted-browser-analysis-runbook.md tests/test_hosted_stateless_runtime.py web/src/HostedAnalysisE2E.test.tsx
git commit -m "docs: prepare browser analysis rollout"
```

---

## Phase acceptance criteria

- Two compatible requests for `magnuscarlsen` resolve to one shared job and one active browser lease.
- A second subscribed browser resumes from the latest acknowledged checkpoint after the first browser disappears and its 60-second lease expires.
- Stopping one user's observation cannot cancel another user's work or hide already-ready features.
- Future entitled users reuse completed immutable results without recalculation.
- Hosted Render runs no Stockfish process and stores no hosted artifacts on its filesystem.
- Supabase holds explicit-grant/RLS-protected coordination state and immutable artifacts with `community_computed` provenance.
- Browser refresh, offline transition, quota failure, upload interruption, stale lease, and unsupported capabilities have tested recovery or clear observer-only behavior.
- Python and TypeScript parity fixtures pass for move classification, features, puzzles, model summaries, and reports.
- Local Python CLI/web workflows remain backward-compatible and require neither Supabase nor browser WASM.
- The browser feature remains disabled in committed production configuration until an explicit deployment/canary action.
