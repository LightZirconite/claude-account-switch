// Compare the installed official CLIs with the releases this switcher was last audited
// against. A newer CLI is not an error: credential formats usually stay compatible, but
// the user should know that the switcher has not been re-verified for that release.
import { execFile } from 'node:child_process';

/**
 * The single source of truth for the last provider releases whose credential files,
 * OAuth endpoints, app-server protocol and process names were verified. Bump these
 * only after re-running that audit (see AGENTS.md "Required verification").
 */
export const VERIFIED_TOOL_VERSIONS = {
  claude: '2.1.289',
  codex: '0.153.4',
} as const;

export type VerifiedTool = keyof typeof VERIFIED_TOOL_VERSIONS;

const TOOL_LABELS: Record<VerifiedTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
};

export type ToolVersionStatus = 'verified' | 'newer' | 'older' | 'unknown';

export interface ToolVersionCheck {
  tool: VerifiedTool;
  installed: string | null;
  verified: string;
  status: ToolVersionStatus;
  /** Present only when the installed release is newer than the verified one. */
  warning?: string;
}

/** Extract `major.minor.patch` from `--version` output such as `codex-cli 0.153.4`. */
export function parseToolVersion(output: string | null | undefined): string | null {
  if (typeof output !== 'string') return null;
  const match = output.match(/(?:^|[^\d.])(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?![\d])/);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0);
  const right = b.split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function checkToolVersion(
  tool: VerifiedTool,
  versionOutput: string | null | undefined,
  verified: string = VERIFIED_TOOL_VERSIONS[tool],
): ToolVersionCheck {
  const installed = parseToolVersion(versionOutput);
  if (!installed) return { tool, installed: null, verified, status: 'unknown' };
  const order = compareVersions(installed, verified);
  if (order === 0) return { tool, installed, verified, status: 'verified' };
  if (order < 0) return { tool, installed, verified, status: 'older' };
  return {
    tool,
    installed,
    verified,
    status: 'newer',
    warning: `${TOOL_LABELS[tool]} ${installed} is newer than ${verified}, the last version this switcher was verified against. Account switching should still work; report any login, quota or switch problem.`,
  };
}

/** One-line doctor summary; never includes anything but version numbers. */
export function describeToolVersion(check: ToolVersionCheck): string {
  switch (check.status) {
    case 'verified':
      return `${check.installed} (verified)`;
    case 'older':
      return `${check.installed} (older than verified ${check.verified})`;
    case 'newer':
      return `${check.installed} (NEWER than verified ${check.verified})`;
    default:
      return `unknown (verified against ${check.verified})`;
  }
}

/** Non-blocking `--version` read for the TUI. Resolves null on any failure or timeout. */
export function readVersionOutput(executable: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(executable, ['--version'], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      }, (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}
