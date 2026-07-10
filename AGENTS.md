# Claude + Codex Account Switch - Agent Guide

## Product invariants

- Claude and Codex stores, active profile IDs, credentials and locks are independent.
- A provider operation must never write the other provider's live files.
- Saved profiles survive authentication failure. Mark them for re-authentication; do not
  remove them automatically.
- OAuth rotations must be persisted before releasing the account lock.
- Voluntary deletion creates a tombstone so stale writers cannot restore the account.

## Authentication UX

- Pressing `a` must never open a browser automatically.
- Copy the authorization URL to the clipboard and also display it as a fallback.
- Claude accepts the portable authorization code pasted into the TUI.
- Codex accepts the complete final localhost callback URL pasted into the TUI.
- Never display pasted authorization codes or callback query values; show only their length.
- Escape must cancel a waiting login and leave all existing profiles unchanged.
- Preserve abandoned Codex login homes under `backups/codex-abandoned/` for diagnostics.
- Keep `switch.cmd login claude` as the official Claude CLI fallback.

## Switching safety

- Never force-kill Claude or a standalone Codex CLI process. A confirmed Codex Desktop
  switch may terminate only its identified Desktop process tree after a bounded graceful
  close attempt; the UI must warn that unsaved Desktop work can be lost.
- Validate the target before modifying live authentication.
- Abort before writing when a relevant process refuses to close.
- Replace only the provider-specific auth file atomically and roll back on validation failure.
- Codex shares projects, conversations, settings, plugins and databases across accounts;
  only `~/.codex/auth.json` is switched.

## Provider parity and deliberate differences

- Claude and Codex provide the same account-management surface: add, switch, delete,
  rename, import/export, diagnostics, recovery, backups, quota refresh, maintenance and
  keyboard navigation. A feature added to one provider must be implemented for the other
  in the same change, or the pull request must document a concrete provider limitation.
- Implement parity at the behavioural level, never by forcing both providers through the
  same authentication parser. Claude Code, Claude Desktop, Codex CLI and the Codex Desktop
  app each use different supported credential formats and lifecycle semantics.
- Claude Desktop is an optional Claude-specific capability. Its session capture and restore
  are not a Codex feature and must never be used to infer, parse or mutate Codex state.
- Provider adapters own their credential parsing, live-file paths, validation and refresh.
  Shared UI, stores, locks and backup mechanisms must be provider-neutral and must not
  assume that a field present for Claude also exists for Codex.

## Cross-platform and remote workflows

- Support Windows, macOS and Linux for every non-platform-specific feature. Where desktop
  integration is unavailable, fail clearly without destructive fallback or hidden browser use.
- Treat remote authorization as a first-class workflow: the switcher machine may differ
  from the machine used to sign in. Copy URLs to the clipboard; let the user paste only the
  documented result back into the TUI.
- Validate callback origin, port and path before forwarding it locally. Never bind a public
  listener, expose a token in a command line, or require the authorization browser to run on
  the switcher machine.
- Detect the Codex Desktop application separately from the Codex CLI. Request a graceful
  close, allow a reasonable shutdown period, and abort without writes if it remains active.

## Code quality, performance and change discipline

- Do not leave dead code, stale feature flags, duplicate parsers, unreachable branches or
  unused dependencies. Remove obsolete code in the same change that replaces it.
- The switcher must remain responsive on ordinary personal computers: avoid busy polling,
  repeated full-store writes, unbounded retries and unnecessary process spawns. Use bounded
  backoff, targeted mutations and provider/account-scoped locks.
- Every asynchronous operation must have cancellation, timeout and cleanup behaviour. A
  cancelled login or failed switch must preserve existing profiles and leave diagnostics,
  never partial live credentials.
- Preserve backward compatibility for stored profiles and backups. Migrations must be
  atomic, idempotent and tested against corrupt, stale and intentionally deleted entries.
- Before changing authentication behaviour, verify the current official provider
  documentation and add a regression test for the reported failure mode.

## Secrets

- Never log tokens, authorization codes, callback URLs containing codes, or credential JSON.
- Keep credential envelopes mode `0600` where supported.
- Keep exported credentials provider-tagged and warn that exports contain secrets.

## Required verification

```text
npm test
npm run typecheck
npm run build
node dist/cli.js doctor all
npm audit
```
