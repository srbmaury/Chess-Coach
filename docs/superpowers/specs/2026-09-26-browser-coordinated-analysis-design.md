# Browser-Coordinated Shared Analysis Design

## Status and relationship to the earlier design

This design supersedes the worker and analysis-storage portions of
`2026-09-16-multi-user-shared-analysis-design.md`. Authentication, account profile
limits, shared player identity, and the ₹4,999/month entitlement of five additional
profiles remain unchanged.

The hosted product must not run Stockfish or derived chess calculations on Render.
Render serves the application and authenticated coordination APIs. An authenticated
user's browser performs the work, while Supabase stores durable shared state and
artifacts.

## Objective

Make hosted analysis scale without consuming Render CPU or persistent disk while
avoiding duplicate work when multiple users request the same player and compatible
analysis configuration.

Success means:

- Stockfish and every derived analysis stage run on a user's device.
- A matching player/game-set/configuration has at most one active browser worker.
- Other users subscribe to the shared job instead of recalculating it.
- If the worker disappears, another subscribed browser can resume from a durable
  checkpoint after the lease expires.
- Completed results are reused by future users.
- Render never stores PGNs, checkpoints, models, reports, or analysis artifacts on
  its filesystem.
- Existing local/offline Python workflows remain available and unchanged.

## Product semantics

### Shared jobs

- A job is identified by `(player_id, game_set_hash, analysis_config_hash)`.
- A transaction creates or joins one active job for that key.
- One authenticated browser holds the renewable worker lease at a time.
- Additional browsers observe progress through Supabase Realtime and polling fallback.
- Closing a tab does not cancel the shared job. The lease expires and another active
  subscriber may claim it.
- “Stop observing” only removes that account's subscription. If that account owns the
  lease, it also releases the lease so another subscriber can continue.
- A queued or paused job with no subscribers remains resumable but is not calculated.
- Completed artifacts remain cached independently of subscriber count.
- A user who stops observing retains access to already-completed features, puzzles,
  training, model summaries, and reports. Newly completed results appear when the user
  later opens that entitled profile.

### Worker eligibility

- Only an authenticated account currently entitled to the player may subscribe,
  claim, renew, checkpoint, upload, or finalize a job.
- A worker must keep the analysis page open. Background execution after a tab or
  browser closes is not promised.
- Mobile and low-power clients may opt out of becoming workers and observe only.
- Only one tab per account/device may claim a particular job at a time.

## Architecture

### Browser

The React application owns the compute pipeline:

- A dedicated Web Worker runs Stockfish compiled to WebAssembly so analysis never
  blocks the UI thread.
- Pure TypeScript modules perform move classification, feature extraction, puzzle
  generation, lightweight model calculation, and report-data generation.
- IndexedDB stores the current job manifest, downloaded inputs, uncommitted result
  batches, and the latest acknowledged checkpoint.
- The browser uploads immutable, compressed artifact chunks directly to Supabase
  Storage using short-lived signed upload URLs issued by FastAPI.
- A coordinator client acquires the lease, renews it, emits monotonic progress, and
  stops immediately when renewal fails or ownership changes.

Stockfish assets are immutable and versioned with the web build. The engine version,
depth, MultiPV setting, classification version, feature schema, puzzle algorithm,
model algorithm, and report schema all participate in `analysis_config_hash`.

### FastAPI on Render

Render remains stateless and performs no chess calculation. It:

- verifies Supabase access tokens and account/profile entitlements;
- proxies or signs access to Chess.com data when direct browser access is unavailable,
  streaming responses without writing them to disk;
- transactionally creates/joins jobs and manages subscriptions;
- atomically grants, renews, releases, and expires worker leases;
- validates checkpoint manifests, monotonic counters, hashes, legal game/ply identity,
  size limits, and lease ownership;
- issues scoped signed upload URLs and finalizes uploaded artifacts only after hash and
  manifest validation;
- returns completed shared artifacts through authorized endpoints;
- never accepts an account ID, job owner, status, or entitlement decision as
  authoritative client input.

The backend cannot prove that an arbitrary browser-reported Stockfish evaluation is
honest without repeating the computation. Hosted browser results are therefore marked
`community_computed`. Structural validation prevents corruption and privilege abuse,
but not a determined worker fabricating plausible engine scores. Server-verified
analysis can be added later as a paid trust tier without changing artifact identities.

### Supabase

Supabase is the durable coordination and artifact layer:

- Postgres stores accounts, entitlements, players, games, job metadata, leases,
  subscriptions, checkpoint manifests, result indexes, and audit events.
- Storage stores immutable compressed game inputs, analysis chunks, derived artifacts,
  and reports.
- Realtime private Broadcast topics publish job progress and terminal state. Polling
  the authorized job endpoint remains the correctness path when Realtime is delayed or
  disconnected.
- Browser clients use only the publishable key. The service-role/secret key remains on
  Render. Clients do not receive direct write access to authoritative coordination
  tables.

All exposed tables have explicit grants and RLS. Account-private rows require
`auth.uid() = account_id`; shared rows are readable only through policies that prove an
active profile entitlement or job subscription. Privileged mutation functions live in
an unexposed schema, reject missing `auth.uid()`, have a fixed `search_path`, and expose
only narrowly scoped execution permissions. No custom objects are created inside the
locked `realtime` schema.

## Data model changes

The existing hosted schema remains the base. The following concepts replace the
server-worker assumptions.

### `analysis_jobs`

Retain the shared job key and progress fields. Use statuses:

- `queued`: subscribers exist, but no browser currently owns the lease;
- `running`: a browser owns a valid lease;
- `paused`: work was checkpointed and no valid worker is active;
- `succeeded`, `failed`, or `cancelled`: terminal states.

Add or reinterpret:

- `lease_id`: random opaque identifier whose digest is stored server-side;
- `lease_account_id` and `lease_device_id`;
- `lease_expires_at` and `last_heartbeat_at`;
- `checkpoint_sequence`, `completed_units`, and `total_units`;
- `checkpoint_manifest_key` and `checkpoint_hash`;
- `compute_source`: initially `community_computed`;
- `engine_build_hash` and full configuration hash;
- `last_error_code` and a sanitized error summary.

A partial unique index still permits only one non-terminal job for the shared job key.
Lease acquisition uses a row lock and never trusts client timestamps.

### `job_subscribers`

Track active observation separately from computation:

- `(job_id, account_id)` remains unique;
- state is `active`, `stopped`, or `completed`;
- `can_compute` records the user's opt-in and device suitability;
- stopping a subscription cannot cancel other subscribers or delete shared results.

### `analysis_checkpoints`

Each acknowledged batch has:

- job ID and strictly increasing sequence;
- immutable Storage key, byte size, content hash, and result count;
- first/last game and ply cursor;
- configuration hash and engine build hash;
- uploader account/device and creation time;
- unique `(job_id, sequence)` and `(job_id, content_hash)`.

The latest valid sequence is the resume boundary. Duplicate submissions are
idempotent. A checkpoint is recorded only after the referenced object is present and
its metadata matches.

### `derived_artifacts`

Retain immutable, versioned artifacts. Dependency hashes include all checkpoint hashes
in canonical order. An artifact becomes `ready` only after direct upload and server
finalization. Partial uploads remain unpublished and are eligible for lifecycle cleanup.

## Job protocol

### Create or join

1. An entitled account asks to analyze a player.
2. FastAPI obtains or streams the canonical Chess.com game set, computes its stable
   input manifest/hash, and checks for a compatible completed result.
3. If ready, the API returns the shared result.
4. Otherwise one transaction creates or finds the non-terminal job and upserts the
   account's subscription.
5. The response contains public job state and whether this browser may attempt a lease.

### Claim and calculate

1. An eligible browser posts a random device identifier and capability summary.
2. FastAPI atomically claims an unleased/expired job using database server time and
   returns an opaque lease token plus expiry.
3. The browser downloads the canonical input manifest and latest checkpoint, verifies
   their hashes, and starts the Web Worker at the next unit.
4. The browser renews before half the lease interval. A renewal checks the token,
   authenticated account, device, job status, and current lease ownership.
5. Work is batched into bounded checkpoints. Progress is monotonic and only
   acknowledged after durable artifact finalization.
6. If renewal fails, the Web Worker is terminated before any further upload.

The initial lease interval is 60 seconds, renewed every 20 seconds. A claimant may take
over only after `lease_expires_at` according to Postgres time. These values are server
configuration, not client authority.

### Checkpoint upload

1. The worker asks FastAPI for a signed upload URL tied to one job, expected sequence,
   declared size, and content hash.
2. The browser uploads directly to a temporary Storage key.
3. The browser requests finalization with the lease token and manifest.
4. FastAPI checks lease ownership, sequence, configured size limits, game/ply identity,
   legal moves, object metadata, and hash.
5. One transaction inserts the immutable checkpoint and advances job progress.
6. A private Realtime event announces the committed progress.

Finalization is idempotent. An old lease cannot finalize a checkpoint after takeover.

### Completion and takeover

- The worker finalizes derived artifacts, then requests job completion.
- Completion succeeds only if every expected unit is covered once and all dependency
  hashes match the job configuration.
- If a browser disappears, the lease expires and the job becomes claimable. A new
  worker resumes from the last acknowledged checkpoint; unfinalized uploads are ignored.
- If the last subscriber stops, a running worker releases its lease and the job pauses.
  A future entitled subscriber can resume it.

## Render storage and resource guarantees

- The application never writes hosted PGNs, engine outputs, checkpoints, models, or
  reports to Render disk.
- Request bodies use strict limits and streaming; temporary files are not used.
- Stockfish is not installed or launched in hosted mode.
- Render memory holds only bounded request/response buffers and database connections.
- Render may continue to serve the existing local mode, where user-controlled local
  filesystem storage and native Stockfish remain supported.

## Security and abuse controls

- All job and artifact endpoints require a verified Supabase JWT and entitlement.
- Lease tokens are high-entropy, short-lived secrets; only their digest is persisted.
- Upload URLs are single-object, size-limited, content-type-limited, and short-lived.
- Client progress never directly updates job state in Postgres.
- Checkpoints have bounded batch size and decompressed size to prevent zip bombs.
- Canonical game IDs, legal moves, ply counts, and configuration hashes are validated.
- Per-account/IP rate limits apply to join, claim, renewal, signed upload, and finalize.
- Completed community-computed data carries provenance in APIs and UI.
- Administrators can quarantine an artifact/configuration hash without deleting account
  subscriptions or unrelated results.
- Supabase Storage policies deny arbitrary listing and cross-job writes.

## Failure handling and UX

- Web Worker crashes preserve the last acknowledged checkpoint and show a resumable
  error without corrupting the job.
- Offline transitions stop lease renewal; local unacknowledged batches stay in
  IndexedDB until reconnection, but upload is permitted only while the lease is valid.
- A waiting user sees who is computing only as an anonymous state such as “Another
  browser is analyzing”; account/device identifiers are never exposed.
- When takeover occurs, observers see “Resuming from checkpoint,” not a reset to zero.
- Users can navigate to already-ready features at any time. Stopping observation hides
  progress notifications but never blocks completed features.
- Browsers lacking WebAssembly, Web Workers, required memory, or persistent storage are
  observer-only and receive a clear compatibility message.

## Testing strategy

Tests do not require live Supabase, Chess.com, or Stockfish.

- TypeScript unit tests cover configuration hashing, checkpoint ordering, IndexedDB
  resume behavior, worker cancellation, heartbeat timing, and lease-loss termination.
- Worker integration tests use a deterministic fake UCI engine and verify that the UI
  thread remains responsive.
- Python tests cover authenticated create/join, entitlement enforcement, atomic lease
  claim/renew/release, expiry takeover, idempotent finalization, size/hash/legal-move
  rejection, and sanitized errors.
- Contract tests prove two simultaneous requests yield one job and one lease.
- Contract tests prove stopping one subscription does not stop another, while a stopped
  lease holder releases ownership.
- Database tests cover uniqueness, server-time lease comparisons, explicit grants,
  RLS allow/deny behavior, and indexes used by policies.
- Storage tests cover scoped signed uploads, immutable keys, orphan cleanup eligibility,
  and denial of cross-job access.
- End-to-end browser tests cover worker/observer flows, tab-close takeover, refresh
  resume, completed-result reuse, and unsupported-browser fallback.
- Deployment checks prove hosted mode has no native Stockfish dependency and performs no
  writes beneath Render's application filesystem.

## Migration and rollout

1. Preserve the existing persistence and authentication foundation.
2. Add browser-worker job schema changes, secure coordination APIs, and fake-engine tests.
3. Add versioned Stockfish WASM/Web Worker execution and IndexedDB checkpoints.
4. Add direct-to-Supabase signed artifact uploads and private progress Broadcast.
5. Port derived feature, puzzle, model, and report calculations to pure TypeScript.
6. Run shadow comparisons against existing Python outputs on fixed fixtures.
7. Enable browser computation behind a feature flag for test accounts.
8. Remove the native Stockfish dependency from hosted Render only after parity and
   takeover tests pass. Local CLI behavior remains intact.

No live Supabase schema, Render setting, or production traffic is changed merely by
merging the implementation. Activation is a separate, explicit deployment step.

## Acceptance criteria

- Two users requesting the same compatible Magnus Carlsen analysis create one shared
  job and no more than one active browser lease.
- If the worker closes its tab, another active subscriber resumes from the latest
  acknowledged checkpoint after lease expiry.
- A user stopping observation never cancels another user's work.
- A returning entitled user immediately reuses completed results.
- Hosted Render launches no Stockfish process and persists no analysis artifacts.
- Supabase contains durable, immutable checkpoints/results with explicit provenance.
- Local Python CLI and local web workflows continue using native Stockfish and local
  files without requiring Supabase.
