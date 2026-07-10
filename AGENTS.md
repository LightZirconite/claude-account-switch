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

- Never force-kill Claude or Codex processes.
- Validate the target before modifying live authentication.
- Abort before writing when a relevant process refuses to close.
- Replace only the provider-specific auth file atomically and roll back on validation failure.
- Codex shares projects, conversations, settings, plugins and databases across accounts;
  only `~/.codex/auth.json` is switched.

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
