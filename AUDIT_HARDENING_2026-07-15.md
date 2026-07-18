# Architecture and Reliability Audit — 2026-07-15

## Scope and baseline

- Repository baseline: `5d4bbae`.
- Scope: complete Claude/Codex account lifecycle, OAuth rotation, live switching,
  backups/recovery, Desktop state, process safety, quota scheduling, TUI navigation,
  installer/scheduler, diagnostics, imports/exports and secret handling.
- No commit or push was performed.
- Existing provider boundaries were preserved: Claude operations do not write Codex
  live files, and Codex operations only replace its provider-specific `auth.json`.

## Provider contracts verified

- Anthropic documents interactive Claude Code login, platform-specific credential
  storage and finite organization-controlled session lifetimes. A local tool can retain
  profiles and recovery evidence, but cannot make a revoked server-side grant immortal.
- OpenAI documents ChatGPT login caching in `auth.json` or an OS credential store and
  automatic token refresh. Managed multi-account switching requires a proven file-backed
  effective credential store.
- Codex App Server remains the authoritative interface for account projection, rate
  limits and managed login. Email is display metadata, not the primary account key.

References:

- <https://code.claude.com/docs/en/authentication>
- <https://code.claude.com/docs/en/cli-usage>
- <https://support.claude.com/en/articles/13163631-configuring-session-security-settings>
- <https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code>
- <https://developers.openai.com/codex/auth>
- <https://developers.openai.com/codex/app-server>

## Reliability changes

### Durable profile and credential state

- Metadata stores use atomic replacement, last-known-good sidecars, structural snapshots
  and fail-closed recovery when evidence is ambiguous.
- Secrets were extracted from Claude metadata into provider/account-scoped envelopes.
- Claude OAuth promotion now uses a predecessor compare-and-swap rule. A stale rename,
  quota update or old UI snapshot cannot overwrite a newer rotating refresh token.
- Each rotation writes a recoverable generation before replacing canonical mirrors. The
  valid history is bounded to the latest 24 generations to keep lifetime stores fast.
- Unknown live Claude token chains are quarantined as independent, non-switchable pending
  profiles. Shared organization IDs and typed emails are never ownership proof.
- Provider-backed identity proof can safely promote a normal live Claude rotation back to
  its canonical account; a different same-organization account remains separate.

### Deletion and restoration

- Voluntary deletion writes an authoritative tombstone/archive marker before metadata.
- Portable Claude imports cannot resurrect an archived identity or replace its credentials.
- Explicit Claude restore is two-phase. A crash before the primary metadata commit remains
  retryable; a crash after it but before the sidecar leaves the account visible.
- Selected Claude and Codex backup generations receive unique retention leases for the
  full restore. Creating the rollback backup cannot prune the generation being restored.

### Live-auth transactions and process safety

- Claude's two live auth files are now one journaled transaction. The journal is durable
  before the first write and references the exact rollback manifest by SHA-256.
- A real child-process hard exit between the two atomic renames was tested. Startup
  reclaims only provably abandoned provider/live locks using an opt-in owner-fenced
  takeover, rejects a substituted backup generation and restores the outgoing pair
  byte-for-byte.
- Damaged journals, uncertain process inventory, active provider processes and unverified
  helper shutdowns fail closed while retaining backups and diagnostic evidence.
- Codex App Server homes have exclusive leases. Inspection, login, refresh, switching and
  rollback cannot operate through an unproven surviving helper.
- Codex Desktop and CLI processes are classified separately. Only identified Codex trees
  are eligible for bounded shutdown; Claude is never force-killed.

### Desktop and backups

- Claude Desktop session bundles use a versioned complete manifest with hashes for present
  entries and explicit absence declarations.
- Apply and recapture have durable journals and exact rollback bundles. Unrelated Desktop
  data is preserved.
- Legacy/incomplete backups remain as evidence but are not offered for automatic restore.
- Retention deletes only completed, unprotected generations. Manual-recovery and
  transaction-pinned evidence is never pruned.

### Imports, exports and abandoned login recovery

- Imports validate provider tags, account IDs and credential-chain downgrade attempts.
- Exports reread current durable state under provider and all relevant account-rotation
  locks. Deterministic races prove the JSON contains the new `r2` token, not a stale caller
  object's `r1` predecessor.
- Machine-bound Claude Desktop sessions are explicitly reported as skipped, not presented
  as portable credentials.
- Codex abandoned login sandboxes are inventoried strictly. `z` restores normal tombstones
  first, then can recover the latest valid abandoned login while preserving its source
  archive. Invalid evidence remains visible to `doctor` and is never auto-imported.

## Scheduling, plan refresh and large-account UX

- `Best Now` is provider-neutral and reset-aware. It evaluates every applicable primary,
  secondary, model-scoped, monthly and workspace constraint.
- It requires fresh, complete evidence for an automatic switch, preserves a 5% reserve,
  excludes expired/re-auth accounts and keeps the active account when the alternative is
  materially equivalent.
- Exhausted accounts report the first real recovery time. Low-confidence data is visible
  but cannot silently trigger a switch.
- Claude plan projection is refreshed from the official CLI for the proven active account;
  Codex plans update from App Server account/rate-limit projections.
- The TUI uses a bounded viewport, PageUp/PageDown, first/last shortcuts, search by
  label/email/plan and responsive narrow-terminal layouts. Refresh work is cancellable and
  reports progress without discarding completed account results.

## Security and operations

- Sensitive files use private creation modes where supported and fail-closed same-directory
  atomic replacement. Logs recursively redact tokens, authorization codes and callback
  query values.
- Authorization never opens a browser automatically. URLs are copied/displayed; pasted
  codes and callback values are never echoed.
- Windows Scheduled Tasks use structured actions rather than shell command strings;
  POSIX launchers quote metacharacters and retain explicit runtime homes/binaries.
- Compatible patch updates were applied to `@types/node` and `tsx`. Major React/Ink
  migrations were deliberately not mixed into the reliability change.

## Verification evidence

Executed sequentially after all source changes:

```text
npm test                         130/130 passed
npm run typecheck                passed
npm run build                    passed (dist/cli.js)
node dist/cli.js doctor all      completed both providers, exit 0
npm audit                        0 vulnerabilities
git diff --check                 passed
```

The suite includes real subprocess termination, cross-process lock contention, stale
writers, rotation/export races, corrupt stores, tombstones, retention boundaries,
rollback failures, Desktop journals, cancellation, large-list navigation and Best Now
policy tests.

## Live operator attention (no automatic mutation performed)

1. Claude currently has both `~/.claude/.credentials.json` and
   `~/.claude/credentials.json`. Current provider documentation confirms that Windows and
   Linux use the dotted `.credentials.json`; the switcher now follows that canonical path
   deterministically and preserves the undotted legacy artifact without reading, mutating or
   deleting it.
2. Codex currently reports the effective credential store as `auto/default`. Managed
   account switching/restoration remains intentionally blocked until the effective config
   is explicitly file-backed:

   ```toml
   cli_auth_credentials_store = "file"
   ```

3. One legacy Codex abandoned-login archive has an invalid/missing manifest/auth payload.
   It was retained for manual diagnostics and is not recoverable automatically.

These warnings do not mean saved profiles were deleted. Current diagnostics report no
untracked Claude credential envelopes or Desktop bundles, and both recovery journals are
clean.

## Honest lifetime guarantee

The implementation now guarantees durable local profile retention, bounded credential
history, backups, tombstones and explicit recovery paths. It cannot guarantee that a
provider authorization remains valid forever: Anthropic/OpenAI, an organization admin or
the account owner can expire or revoke server-side sessions. When that happens, the saved
account remains present and is marked for re-authentication rather than being deleted.
