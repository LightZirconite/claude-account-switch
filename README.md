# Claude + Codex Account Switch

A keyboard-driven TUI for keeping independent sets of **Claude Code** and **Codex**
ChatGPT accounts. Use `Left` and `Right` to change provider, inspect cached/live quotas,
and switch only the selected provider's authentication.

![Claude + Codex Account Switch preview](preview.png)

> **Unofficial.** This project is not affiliated with Anthropic or OpenAI. Claude account
> authorization is resolved through Claude's OAuth flow and official CLI; Codex
> authentication and quotas use the official Codex App Server. Claude's quota endpoint
> remains undocumented and is therefore
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

Requires Node.js `>=20.3.0` and the official Claude/Codex CLIs for the providers you use.

Windows:

```powershell
setup.cmd        # install dependencies and build
switch.cmd       # launch; also builds automatically when needed
```

macOS and Linux:

```sh
npm install
npm run build
node dist/cli.js
```

On first launch, the setup screen can configure deterministic file-backed Codex switching
(when Codex account evidence exists), create Desktop/menu shortcuts, and schedule a
cross-platform maintenance run every six hours. Existing `config.toml` content is preserved
and backed up before the single top-level Codex setting is changed. Open setup later with `S`.

```powershell
switch.cmd install
switch.cmd uninstall
```

On macOS and Linux, use `node dist/cli.js install` and
`node dist/cli.js uninstall` instead. The installer reports shortcut and scheduler results
independently, so a platform integration failure is visible without hiding successful steps.

## Keys

The account actions apply only to the visible provider.

| Key | Action |
| --- | --- |
| Left/Right | switch between Claude and Codex tabs |
| Up/Down | move that provider's independent cursor |
| PageUp/PageDown, g/G | move by a viewport / jump to first or last account |
| / | find the next account by label, email or plan |
| ? | explain every navigation and account-management shortcut |
| Enter | switch to the selected account |
| a | copy a remote authorization URL, then paste the returned code/callback |
| i / I | import interactively / import an export-all bundle or folder |
| e / E | export selected / all portable credentials for the visible provider |
| r | rename the selected account |
| d | archive the selected non-active account without destroying credentials |
| z | restore the most recently archived account for the visible provider |
| l | highlight the account with the most raw quota headroom |
| b | refresh quotas, then choose the reset-aware **Best Now** account |
| u | refresh quotas for the visible provider (duplicate requests are coalesced) |
| S | setup shortcuts and scheduled maintenance |
| q | quit |

Moving the cursor previews that account's cached or freshly-read quota without switching
accounts. A `0%` five-hour bucket with no provider reset timestamp is shown as
`available now`: the rolling window has not started, so there is no honest clock time to
display yet.

**Best Now** is deliberately different from `l`. It trusts fresh, complete quota snapshots
before cached or partial ones, keeps a 5% reserve in every applicable window, then spends
useful capacity from the window that resets soonest. Equivalent choices keep the active
account to avoid an unnecessary process restart. Low-confidence data is shown as an
estimate but never triggers an automatic switch. When every account is exhausted, it
reports the first real upcoming reset instead of switching to a blocked account.
When only the protected final 5% remains, it reports that reserve separately instead of
calling the accounts exhausted.

The list is vertically windowed, so hundreds of accounts do not produce an unbounded Ink
render; `/` jumps directly by label, email or plan. Narrow terminals automatically hide
secondary columns while the selected-account panel retains email, plan, quota, renewal
and active-state details.

Codex switching is performed by a detached worker. It validates the target first, closes
detected Codex CLI sessions, asks the desktop app to close gracefully, then terminates only
the revalidated Codex processes allowed by the safety policy if needed. It swaps `auth.json` atomically, validates the
result through App Server, and rolls back on failure. The confirmation warns that unsaved
Codex work can be lost; Claude processes are never force-killed.

## Remote authorization

Pressing `a` never opens a browser. The authorization URL is copied to the clipboard and
also shown in the TUI so it can be sent to another computer.

- Claude: authorize remotely, copy the final authorization code, paste it into the TUI,
  then press Enter.
- Codex: authorize remotely, copy the complete final `http://localhost:...` callback URL,
  paste it into the TUI, then press Enter. The switcher forwards it only to the exact local
  callback origin/path created for that login attempt.
- Escape cancels either flow before its one-shot result is submitted, without changing saved
  accounts. After Enter, Claude finishes the exchange and durable checkpoint before honoring
  any cancellation intent; the UI says this explicitly instead of pretending a consumed code
  can be undone. Failed or cancelled Codex sandboxes are retained with a non-secret reason
  manifest under `backups/codex-abandoned/`. If App Server shutdown cannot be proven, its
  home stays at the exact original path until recovery can safely establish that no helper
  still owns it.

On Windows, `switch.cmd login claude` remains an isolated wrapper around the official
Claude CLI login when Anthropic changes the portable paste-code flow. Linux provides the
same fallback as `node dist/cli.js login claude`. The resulting rotating credential is
committed before the isolated login home is removed.

On macOS, Claude Code stores OAuth in the login Keychain. Because current provider
documentation does not establish that `CLAUDE_CONFIG_DIR` isolates that Keychain entry,
parked-account add, switching and transactional restore fail clearly instead of risking
the live account. Stored profile metadata, import/export and diagnostics remain available,
but changing the live Claude login on macOS must use Anthropic's official
`claude auth login` directly. This is a documented provider limitation rather than
pretending file and Keychain auth have identical lifecycle semantics.

## Reliability model

- OAuth refreshes are single-flight in-process and locked across processes.
- A newly-issued Claude refresh token is checkpointed into a recoverable pending profile
  before identity probing; an isolated official-login home is retained if its commit fails.
- A live Claude chain whose identity cannot be attributed is checkpointed into a distinct,
  non-switchable recovery profile. Workspace organization IDs are never treated as account
  identity because Team/Enterprise members can share them; the known account envelope and
  the ambiguous candidate both remain intact.
- Parked Claude rotations are written first to mirrored, independently readable per-account
  envelopes and an append-before-replace CAS generation. For the active account, the switcher
  may rotate only while two process checks prove that no official Claude client is running; it
  atomically updates the official live file first, then promotes the saved envelope with an
  exact predecessor CAS. Metadata never changes before a durable credential copy exists, stale
  writers cannot replace newer generations, and valid history is bounded to the newest 24.
- If Claude is running, it exclusively owns the active refresh token and the switcher preserves
  cached quota instead of rotating underneath it. After a reboot or while Claude is closed,
  startup, `u`, and scheduled maintenance can safely renew the expired active token under the
  provider lock, so the active account no longer remains stale merely because the PC was off.
- Codex does not need this Claude-specific quiescence path: active Codex renewal stays inside
  the official App Server `account/read(refreshToken=true)` lifecycle and its isolated adapter.
- If the running official client replaces the active OAuth chain completely, reconciliation
  promotes it only when the stable account UUID plus the official status e-mail and
  organization all identify the same saved profile. A mismatch remains quarantined; e-mail
  or a shared organization alone can never overwrite a saved credential.
- Sensitive writes use a shared fail-closed primitive: a unique same-directory temp file,
  `0600`, file flush, then atomic rename. There is no direct-write fallback that could
  truncate a valid credential. Stores use last-known-good mirrors, actually-read recovery
  snapshots and reversible
  tombstones. A stale writer cannot silently remove or resurrect a profile; an explicit
  `z` restore uses a recoverable two-phase marker and records a newer event, so a crash at
  either metadata boundary leaves the account visible or the restore retryable. Portable
  imports cannot silently resurrect voluntarily archived Claude identities.
- Claude's two live auth files are covered by a durable transaction journal anchored to the
  exact rollback-manifest SHA-256. Startup reclaims only provably abandoned switch/live locks,
  rejects substituted recovery generations, and restores the outgoing pair byte-for-byte
  after a crash between the two atomic renames.
- Claude Desktop captures use a versioned, complete session scope. Every present file or
  deterministic directory tree and every explicit absence is covered by the v2 manifest;
  application validates it before and after the swap. A durable transaction journal
  restores the exact outgoing bundle after an interrupted apply/recapture, while unrelated
  Desktop settings remain untouched. Legacy v1 captures remain listed for recovery but
  must be recaptured before switching because they have no integrity fingerprints.
- A manually typed Desktop email never auto-links or replaces a Claude Code credential.
  Desktop captures default to independent rows; machine-bound sessions are explicitly
  reported as skipped by portable exports.
- Last known quotas remain visible as `stale` when a live refresh fails.
- Credential exports take provider and per-account rotation locks, reconcile and reread the
  durable stores, and refuse to run while process safety is unknown. They therefore cannot
  serialize an invalid predecessor from a stale TUI object.
- Cancelled/failed Codex login sandboxes remain under `backups/codex-abandoned/`; `doctor codex`
  inventories valid and damaged evidence, while `z` can explicitly recover the newest valid
  login without deleting its diagnostic archive.
- Each Claude/Codex account has a separate credential envelope under
  `~/.claude-switch/credentials/`.

Maintenance cannot guarantee an authorization forever. Anthropic documents expiring login
sessions and warns shortly before renewal is required; an organization administrator can
also enforce a shorter session. OpenAI documents that Codex caches ChatGPT login either in
`auth.json` or the OS credential store and refreshes ChatGPT tokens automatically. Either
provider can still revoke a session server-side. The switcher therefore promises durable
**profile retention**, not immortal OAuth grants: metadata, last-known quota and recovery
copies remain present and the row is marked for re-authentication.

Current provider references:

- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude session security controls](https://support.claude.com/en/articles/13163631-configuring-session-security-settings)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex App Server](https://developers.openai.com/codex/app-server)

Codex profiles deliberately store file-backed `auth.json` copies. Managed reconciliation,
refresh and switching therefore require this effective setting in `~/.codex/config.toml`:

```toml
cli_auth_credentials_store = "file"
```

Every switch additionally starts the official App Server without overriding that setting
and verifies that Codex's effective credential projection matches the selected account.
An `auto`/keyring/config mismatch fails closed instead of associating workspaces by email;
`doctor all` reports the effective credential-store setting.

## Command line

```text
switch.cmd login claude
switch.cmd login codex
switch.cmd import --provider claude <path>
switch.cmd import --provider codex <path>
switch.cmd import-all --provider claude <bundle-or-folder>
switch.cmd import-all --provider codex <bundle-or-folder>
switch.cmd export-all claude
switch.cmd export-all codex
switch.cmd doctor all
switch.cmd keep-alive
switch.cmd --dry-run
switch.cmd restore claude [backup-path]
switch.cmd restore codex [backup-path]
switch.cmd --help
```

Those examples use the Windows launcher. On macOS and Linux, replace `switch.cmd` with
`node dist/cli.js`.

`doctor all` reports both providers without printing tokens. `keep-alive` isolates Claude
and Codex failures: both providers run even if one is corrupt, and the command exits
non-zero with an aggregate summary when either provider fails.

## Files and privacy

Everything managed by the switcher lives under `~/.claude-switch/` by default. Set
`CLAUDE_SWITCH_HOME` to place the switcher store elsewhere; `--switch-home <path>` is the
equivalent per-invocation flag. Scheduled maintenance captures the resolved switcher,
Claude and Codex homes when it is installed. This switcher store is independent from
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`:

- `profiles.json` / `.bak`: Claude metadata, active account and tombstones (no OAuth token)
- `codex-profiles.json` / `.bak`: Codex metadata, active account and tombstones
- `credentials/claude/<id>/credentials.json`: one Claude OAuth envelope per account
- `credentials/claude/<id>/generations/`: bounded CAS history for rotating Claude credentials
- `credentials/codex/<id>/auth.json`: one Codex ChatGPT auth file per account
- `transactions/claude-live-auth.json`: pending two-file recovery journal (normally absent)
- `backups/`: account-set, deleted-account and pre-switch rollback snapshots
- `logs/switch.log`: activity log with secret values redacted
- `import/` and `exports/`: portable files containing secrets; protect them like passwords

Credential envelopes are plain JSON protected by user-directory permissions, not
application-level encryption. Never commit or share them. Legacy profile stores are migrated
atomically. Legacy backups remain retained as recovery evidence, but automatic restore refuses
formats that cannot prove a complete integrity-scoped generation.

On Windows and Linux, live Claude Code OAuth is always read from the provider-owned
`~/.claude/.credentials.json` (or `.credentials.json` under `CLAUDE_CONFIG_DIR`). An undotted
`credentials.json` sibling is ignored and preserved as recovery evidence; it never blocks quota
refresh, login reconciliation or account switching.

## Development

```text
npm test
npm run typecheck
npm run build
node dist/cli.js doctor all
npm audit
```

The test suite also covers fail-closed atomic replacement, recursive log redaction, corrupt
store recovery, strict Codex imports, transaction rollback including initially absent live
files, quota confidence/reserve/hysteresis, large-list viewport navigation, provider
isolation, remote callback validation and abandoned-login preservation.

## License

Created by **LightZirconite**. Licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Attribution must be retained.
