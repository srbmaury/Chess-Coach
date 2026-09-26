# Multi-User Shared Analysis Design

## Objective

Evolve Chess ML Coach from a single-operator, filesystem-backed application into a multi-user hosted product while preserving local/offline operation.

The hosted product will provide:

- Supabase email magic-link authentication.
- One free Chess.com profile per application account.
- A ₹4,999 monthly subscription that adds five profile slots, for six total.
- Globally shared Chess.com player data and deduplicated Stockfish analysis.
- User-specific puzzle review history and entitlements.
- A resumable PostgreSQL-backed job queue serviced by one worker inside the existing Render web service.
- Supabase Storage for durable artifacts.
- Stripe Checkout and verified webhooks for subscription state.

The initial architecture must work within the existing free Render web-service constraint. It must preserve boundaries that allow the worker to move to dedicated paid compute later.

## Product Rules

### Profile entitlements

- Every authenticated account receives one free profile slot.
- The first claimed Chess.com profile consumes the free slot.
- A user cannot replace the free profile through normal product flows. Account recovery or administrative support is required for exceptional reassignment.
- An active paid subscription costs ₹4,999 per month and provides five additional profile slots.
- A paid account therefore supports six active profiles total.
- The same player cannot consume multiple slots in one account.
- Removing a paid profile frees its slot but does not delete shared player data or cached analysis.
- When a paid subscription becomes inactive, the free profile remains usable. Paid profiles become read-only, cannot request refreshes, and remain available for selection or removal so the user can recover cleanly.

Profile access does not prove ownership of the corresponding Chess.com account. It is an application entitlement and compute-allocation rule. Chess.com OAuth is outside this initial scope.

### Shared work

- Chess.com players, games, and compatible Stockfish results are global shared resources.
- Requests for the same player and analysis configuration reuse existing completed results or join the same active job.
- A user's job subscription represents interest in progress and notification; it does not own the shared computation.
- Leaving a progress view has no effect on the job.
- Cancelling a user's request removes only that subscription.
- A queued job with no subscribers is cancelled.
- A running job with no subscribers may stop at its next checkpoint to conserve compute.
- A completed job and its artifacts remain cached independently of subscriber count.
- Force cancellation and shared-artifact deletion are administrative operations.

## Architecture

### Hosted mode

The hosted application remains a FastAPI and React modular monolith on Render. It integrates with:

- Supabase Auth for email magic-link sessions.
- Supabase Postgres for authoritative application state and the job queue.
- Supabase Storage for PGNs, Parquet data, models, reports, and puzzle exports.
- Stripe Checkout and webhooks for recurring subscription billing.
- Chess.com's public API for player profiles and game archives.
- A local Stockfish process inside the Render container.

FastAPI verifies each Supabase JWT and resolves an internal account before executing protected operations. The React application never supplies an authoritative account ID.

One worker loop inside the Render process claims jobs from PostgreSQL and executes existing pipeline services through repository interfaces. Database leases, retry metadata, and incremental checkpoints make jobs resumable after process replacement. The worker boundary must not depend on FastAPI request objects so it can later move unchanged to a dedicated worker service.

### Local mode

The existing filesystem-backed workflow remains supported for local and offline use. Hosted persistence is introduced behind interfaces rather than by deleting current local services. CLI commands continue to use local files unless explicitly configured for hosted mode.

### Component boundaries

- **Identity service:** verifies Supabase JWTs and loads accounts.
- **Entitlement service:** calculates available slots and transactionally enforces profile limits.
- **Player catalog:** resolves canonical Chess.com identities and shared player metadata.
- **Game repository:** stores global games and player-game relationships.
- **Analysis repository:** identifies compatible shared results using deterministic configuration keys.
- **Job service:** creates or joins deduplicated jobs, manages subscriptions, and exposes account-scoped progress.
- **Worker:** leases jobs, invokes pipeline stages, checkpoints progress, and publishes terminal results.
- **Artifact repository:** uploads immutable artifacts and publishes their metadata only after successful storage.
- **Billing service:** creates Stripe Checkout sessions and applies verified webhook events idempotently.
- **Training service:** stores private per-account puzzle-review state referencing shared puzzles.

Each boundary will have a protocol or repository interface and local/test implementations where appropriate.

## Data Model

### `accounts`

- `id`: UUID matching the Supabase Auth user ID.
- `email`: normalized email for display and support.
- `stripe_customer_id`: nullable, unique.
- `created_at`, `updated_at`.

Billing status is not accepted from clients and is not inferred from redirect URLs.

### `subscriptions`

- `id`.
- `account_id`.
- `stripe_subscription_id`, unique.
- `stripe_price_id`.
- `status`.
- `current_period_end`.
- `cancel_at_period_end`.
- `last_event_created_at`.
- timestamps.

Only verified Stripe webhook processing changes authoritative subscription status.

### `players`

- `id`.
- `chesscom_player_id`, nullable and unique when present.
- `canonical_username`, unique.
- display/profile metadata.
- `last_synced_at`.
- timestamps.

Chess.com's stable player ID is preferred for rename detection. Canonical username is the fallback identity when that ID is unavailable.

### `account_profiles`

- `id`.
- `account_id`.
- `player_id`.
- `slot_type`: `free` or `paid`.
- `state`: `active`, `read_only`, or `removed`.
- timestamps.

Constraints prevent duplicate active account/player links and more than one active free slot. A transactional entitlement check enforces no more than five paid slots.

### `games`

- `id`.
- `chesscom_url`, nullable and unique when present.
- `pgn_hash`, unique fallback identity.
- PGN storage key and normalized metadata.
- timestamps.

### `player_games`

- `player_id`.
- `game_id`.
- player color and relevant relationship metadata.
- unique `(player_id, game_id)`.

### `analysis_configs`

- `id`.
- Stockfish version.
- depth.
- classification thresholds.
- schema/algorithm version.
- deterministic `config_hash`, unique.

The hosted product initially exposes one bounded standard configuration. Arbitrary user-selected depths are not supported.

### `analysis_jobs`

- `id`.
- `player_id`.
- `analysis_config_id`.
- input game-set hash.
- `stage`.
- `status`: `queued`, `running`, `stopping`, `succeeded`, `failed`, or `cancelled`.
- completed/total work counters.
- lease owner and lease expiry.
- attempt count and maximum attempts.
- checkpoint metadata.
- last error.
- timestamps.

A partial unique index permits only one queued or running job for the same player, configuration, and game-set hash.

### `job_subscribers`

- `job_id`.
- `account_id`.
- subscription state and notification preference.
- timestamps.
- unique `(job_id, account_id)`.

### `move_analyses`

- `game_id`.
- ply.
- `analysis_config_id`.
- engine result fields currently written to `analysis.parquet`.
- timestamps.
- unique `(game_id, ply, analysis_config_id)`.

This is the primary deduplication boundary: identical chess content under the same engine configuration is analyzed once.

### `derived_artifacts`

- `id`.
- `player_id`.
- optional `account_id` for private artifacts.
- artifact type.
- dependency hash.
- schema version.
- Supabase Storage bucket/key.
- status and metadata.
- timestamps.

Storage keys are immutable and versioned. A database record is published only after upload completes.

### `puzzle_reviews`

- `account_id`.
- shared puzzle ID.
- scheduling, accuracy, streak, and review timestamps.
- unique `(account_id, puzzle_id)`.

### `stripe_events`

- Stripe event ID, unique.
- event type and creation timestamp.
- processing status and failure details.
- processed timestamp.

This table provides webhook replay protection and repair visibility.

### `audit_events`

Records profile entitlement changes, billing transitions, job cancellation, retries, and administrative actions with actor, target, action, and timestamps.

## Data Flow

### Authentication and onboarding

1. React requests a Supabase email magic link.
2. Supabase completes authentication and issues a session.
3. React includes the access token in API requests.
4. FastAPI verifies the JWT and upserts/loads `accounts`.
5. The user claims a Chess.com username.
6. FastAPI validates the public Chess.com profile, creates or reuses `players`, and transactionally allocates the free slot.

### Requesting analysis

1. The account requests preparation or refresh for an entitled player.
2. The server synchronizes or assesses game freshness.
3. It computes the game-set hash and standard analysis configuration hash.
4. If compatible artifacts are complete, it returns `ready` immediately.
5. If a matching job is active, it creates or restores `job_subscribers` and returns that job.
6. Otherwise it creates one queued job and subscribes the requester in the same transaction.
7. The worker leases the job and checkpoints after bounded units of work.
8. Progress is read from account-authorized job endpoints and streamed through an account-scoped event endpoint or polling fallback.
9. On completion, shared derived stages publish artifacts and the job becomes `succeeded`.

### Cancellation

- Closing the tab or choosing "Continue in background" only disconnects progress observation.
- "Cancel my request" marks that account's job subscription inactive.
- If subscribers remain, work continues.
- If no subscribers remain and the job is queued, it is cancelled transactionally.
- If no subscribers remain and the job is running, a cancellation request is recorded and honored at the next safe checkpoint.
- Admin force-cancellation is separate and audited.

### Billing

1. A free user requesting a second profile creates a Stripe Checkout Session for the configured ₹4,999 monthly Price.
2. Checkout redirects are treated only as presentation state.
3. Stripe sends signed webhook events.
4. FastAPI verifies the signature, claims the event ID once, and updates `subscriptions` idempotently.
5. Active/trialing subscription states enable five paid slots.
6. Inactive subscription states make paid profile links read-only and prevent new paid refresh jobs.

## User Experience

The hosted UI removes the operator-oriented Pipeline page from normal navigation. Users see one product flow:

```text
Syncing games → Analyzing moves → Building insights → Creating puzzles → Ready
```

The UI exposes:

- Player search and profile cards.
- One free-profile onboarding step.
- A plan/slot indicator.
- Stripe upgrade when a second profile is requested.
- A shared progress view that clearly states work can continue in the background.
- "Continue in background" and "Cancel my request" actions with accurate semantics.
- Ready-state actions for Insights, Puzzles, Model, and Report.
- Read-only labeling for paid profiles after subscription expiry.

The detailed queue, retries, leases, and force-cancellation controls are reserved for an authenticated admin surface.

## Reliability and Failure Handling

- Workers claim jobs with PostgreSQL row locking and a renewable lease.
- Expired leases allow interrupted work to be reclaimed.
- Checkpoints and unique move-analysis keys make reprocessing idempotent.
- Jobs use bounded attempts and record actionable terminal errors.
- Chess.com calls are serial, conditional-cache-aware, and retry only rate limits and temporary failures with exponential backoff.
- Stockfish depth and configuration are server-controlled in hosted mode.
- Artifact uploads use temporary/versioned keys; metadata is published only after upload succeeds.
- Derived artifacts carry dependency hashes so stale outputs are rebuilt without discarding valid prerequisites.
- A failed derived stage does not delete completed synchronization or move analysis.
- Render restart recovery scans expired running jobs and returns them to claimable state.

## Security

- All hosted product APIs except health checks, auth callbacks, and Stripe webhooks require a verified Supabase JWT.
- Authorization is resolved from the verified subject, never a client account ID.
- Supabase service-role and Stripe secret keys remain backend-only.
- Row-level security provides defense in depth for private account, billing, and review data.
- Stripe webhook signatures are mandatory.
- Profile creation, refresh, checkout, and job operations are rate-limited per account and IP.
- Users cannot delete global players, games, analyses, or artifacts.
- Users cannot cancel another account's subscription to a job.
- Administrative actions require a separate configured allowlist/role and are audited.
- Local backup files and current `data/` and `models/` directories remain excluded from Docker and Git.

## Testing Strategy

Tests will use repository fakes and local database fixtures; they will not require live Supabase, Stripe, Chess.com, or Stockfish.

Required coverage includes:

- JWT verification and rejection paths.
- Cross-account authorization isolation.
- Free-slot and five-paid-slot enforcement, including concurrent requests.
- Profile removal, read-only expiry behavior, and renewal.
- Stripe webhook signatures, replay handling, out-of-order events, and idempotent repair.
- Shared-job creation under concurrent requests.
- Subscriber join, leave, queued cancellation, and running checkpoint cancellation.
- Worker leasing, lease renewal, lease expiry, process recovery, retries, and exhaustion.
- Move-analysis deduplication and checkpoint resume.
- Artifact upload publication and dependency invalidation.
- React auth, onboarding, checkout, progress, cancellation wording, read-only, and ready states.
- Compatibility of existing local CLI and filesystem workflows.
- Migration and import of existing local analysis as an optional administrative operation.

## Delivery Phases

1. Persistence foundation: configuration, Supabase schema, repository interfaces, migrations, and local compatibility.
2. Authentication and account-scoped authorization.
3. Profile entitlements and shared player/game catalog.
4. Database-backed jobs, subscriptions, leases, resumable worker, and shared analysis.
5. Supabase Storage artifact persistence and derived-stage orchestration.
6. Stripe Checkout, webhooks, and six-slot paid entitlement behavior.
7. Hosted product UX replacing the global pipeline controls.
8. Rate limiting, admin operations, observability, migration tooling, and deployment verification.

Each phase must preserve a green test suite and be independently reviewable. Hosted features remain disabled until required configuration is present; local mode continues to work throughout migration.

## Explicit Non-Goals for Initial Release

- Chess.com OAuth or proof of Chess.com profile ownership.
- Unlimited or arbitrary-depth Stockfish analysis.
- Multiple simultaneous Stockfish workers on free infrastructure.
- Horizontal Render scaling.
- Native mobile applications.
- Organization/team accounts.
- Per-profile à-la-carte purchases.
- Deleting shared cached analysis when an account removes a profile.

## Success Criteria

- Two accounts requesting the same player and configuration produce one shared analysis job.
- Either account can leave progress without interrupting the other.
- One account cannot stop or access another account's private state.
- A free account cannot allocate a second profile.
- A verified active ₹4,999 monthly subscription enables exactly five additional slots.
- Render process replacement does not lose authoritative state and interrupted analysis resumes from persisted checkpoints.
- Completed shared artifacts are durable in Supabase Storage and reusable by later accounts.
- Existing local CLI and web behavior remains usable without Supabase or Stripe configuration.
