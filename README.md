# Claude + Codex Account Switch

A keyboard-driven TUI for keeping independent sets of **Claude Code** and **Codex**
ChatGPT accounts. Use `Left` and `Right` to change provider, inspect cached/live quotas,
and switch only the selected provider's authentication.

![Claude + Codex Account Switch preview](preview.png)

> **Unofficial.** This project is not affiliated with Anthropic or OpenAI. Claude account
> creation uses the official Claude CLI; Codex authentication and quotas use the official
> Codex App Server. Claude's quota endpoint remains undocumented and is therefore
> best-effort. Use only accounts you own.

## Provider isolation

| Behavior | Claude | Codex |
| --- | --- | --- |
| Active credentials | Claude credential/config files | `~/.codex/auth.json` only |
| Add account | portable paste-code OAuth flow | App Server `account/login/start` |
| Identity | Claude live files/status | App Server `account/read` + `account_id` |
| Quotas | cached best-effort Claude usage | App Server `account/rateLimits/read` |
| Maintenance | serialized OAuth rotation | forced App Server token refresh |
| Shared data | Claude projects/settings preserved | all of `~/.codex` except `auth.json` preserved |

Claude and Codex have separate stores, active profile IDs, credentials, tombstones and
locks. A Codex operation never writes Claude files, and a Claude operation never writes
`~/.codex`.

## Setup

Requires Node.js 20+ and the official Claude/Codex CLIs for the providers you use.

```text
setup.cmd        # install dependencies and build
switch.cmd       # launch; also builds automatically when needed
```

On first launch, the setup screen can create Desktop/menu shortcuts and schedule a
cross-platform maintenance run every six hours. Open it later with `S`.

```text
switch.cmd install
switch.cmd uninstall
```

## Keys

The account actions apply only to the visible provider.

| Key | Action |
| --- | --- |
| Left/Right | switch between Claude and Codex tabs |
| Up/Down | move that provider's independent cursor |
| Enter | switch to the selected account |
| a | copy a remote authorization URL, then paste the returned code/callback |
| i | import provider-tagged credentials |
| e / E | export selected / all accounts for the visible provider |
| r | rename the selected account |
| d | delete the selected non-active account |
| l | highlight the account with the most quota headroom |
| b | switch to the account with the most quota headroom |
| u | refresh quotas for the visible provider |
| S | setup shortcuts and scheduled maintenance |
| q | quit |

Codex switching is performed by a detached worker. It validates the target first, refuses
to continue while a Codex CLI is active, asks the desktop app to close gracefully, swaps
`auth.json` atomically, validates the result through App Server, and rolls back on failure.
No process is force-killed.

## Remote authorization

Pressing `a` never opens a browser. The authorization URL is copied to the clipboard and
also shown in the TUI so it can be sent to another computer.

- Claude: authorize remotely, copy the final authorization code, paste it into the TUI,
  then press Enter.
- Codex: authorize remotely, copy the complete final `http://localhost:...` callback URL,
  paste it into the TUI, then press Enter. The switcher forwards it only to the exact local
  callback origin/path created for that login attempt.
- Escape cancels either waiting flow without changing saved accounts. An interrupted Codex
  sandbox is moved into `backups/codex-abandoned/` on recovery instead of being discarded.

`switch.cmd login claude` remains an official interactive CLI fallback when Anthropic
changes the portable paste-code flow.

## Reliability model

- OAuth refreshes are single-flight in-process and locked across processes.
- A rotated token is persisted before its account lock is released.
- The active Claude account is reconciled to disk before any refresh, preventing a live
  Claude session from racing a stale cached refresh token.
- Stores use atomic writes, last-known-good mirrors, account-set snapshots and deletion
  tombstones. A stale writer cannot silently remove or resurrect a profile.
- Last known quotas remain visible as `stale` when a live refresh fails.
- Each Claude/Codex account has a separate credential envelope under
  `~/.claude-switch/credentials/`.

Maintenance cannot guarantee a login forever. Anthropic documents a finite Claude login
lifetime, and either provider may revoke a login server-side. In those cases the local
profile and cached quota remain present, but the row is marked for re-authentication.

## Command line

```text
switch.cmd login claude
switch.cmd login codex
switch.cmd import --provider claude <path>
switch.cmd import --provider codex <path>
switch.cmd export-all claude
switch.cmd export-all codex
switch.cmd doctor all
switch.cmd keep-alive
switch.cmd --dry-run
switch.cmd restore
switch.cmd --help
```

`doctor all` reports both providers without printing tokens. `keep-alive` runs Claude and
Codex sequentially, while each provider/account still uses its own lock.

## Files and privacy

Everything managed by the switcher lives under `~/.claude-switch/`:

- `profiles.json` / `.bak`: Claude metadata, active account and tombstones (no OAuth token)
- `codex-profiles.json` / `.bak`: Codex metadata, active account and tombstones
- `credentials/claude/<id>/credentials.json`: one Claude OAuth envelope per account
- `credentials/codex/<id>/auth.json`: one Codex ChatGPT auth file per account
- `backups/`: account-set, deleted-account and pre-switch rollback snapshots
- `logs/switch.log`: activity log with secret values redacted
- `import/` and `exports/`: portable files containing secrets; protect them like passwords

Credential envelopes are plain JSON protected by user-directory permissions, not
application-level encryption. Never commit or share them. Existing v1 files and backups
are migrated atomically and retained for recovery.

## Development

```text
npm test
npm run typecheck
npm run build
switch.cmd doctor all
```

The test suite covers legacy three-profile recovery, credential extraction, concurrent
mutations, tombstones, provider isolation, cursor independence, remote callback validation,
active-marker drift, abandoned login recovery and Codex auth rollback.

## License

Created by **LightZirconite**. Licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Attribution must be retained.
