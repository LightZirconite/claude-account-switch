import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWriteFile } from './atomicFile';
import { dataDir } from './paths';

export type DesktopProvider = 'claude' | 'codex';

export interface DesktopLaunchDescriptor {
  exe: string;
  args: string[];
}

interface LinuxDesktopConfig {
  version: 1;
  container: string;
  apps: Record<DesktopProvider, DesktopLaunchDescriptor>;
}

export interface LinuxDesktopDiagnostic {
  ok: boolean;
  lines: string[];
}

const DEFAULT_CONTAINER = 'claude-codex-desktop';

export function linuxDesktopConfigPath(): string {
  return path.join(dataDir(), 'linux-desktop.json');
}

function validateText(label: string, value: string): string {
  const clean = value.trim();
  if (!clean || /\0|[\r\n]/u.test(clean)) throw new Error(`${label} must be a non-empty single-line value.`);
  return clean;
}

function validateDescriptor(provider: DesktopProvider, value: unknown): DesktopLaunchDescriptor {
  if (!value || typeof value !== 'object') throw new Error(`Missing ${provider} Desktop launch descriptor.`);
  const input = value as Partial<DesktopLaunchDescriptor>;
  const exe = validateText(`${provider} executable`, String(input.exe ?? ''));
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string' || /\0|[\r\n]/u.test(arg))) {
    throw new Error(`${provider} Desktop arguments must be an array of single-line strings.`);
  }
  return { exe, args: [...input.args] };
}

function validateConfig(value: unknown): LinuxDesktopConfig {
  if (!value || typeof value !== 'object') throw new Error('Linux Desktop configuration must be an object.');
  const input = value as Partial<LinuxDesktopConfig>;
  if (input.version !== 1) throw new Error('Unsupported Linux Desktop configuration version.');
  const container = validateText('Distrobox container', String(input.container ?? ''));
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(container)) throw new Error('Distrobox container name contains unsupported characters.');
  return {
    version: 1,
    container,
    apps: {
      claude: validateDescriptor('claude', input.apps?.claude),
      codex: validateDescriptor('codex', input.apps?.codex),
    },
  };
}

export function loadLinuxDesktopConfig(): LinuxDesktopConfig | null {
  try {
    return validateConfig(JSON.parse(fs.readFileSync(linuxDesktopConfigPath(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Persist no-shell launch descriptors for apps installed in one Ubuntu Distrobox. */
export function configureLinuxDesktopDistrobox(container = DEFAULT_CONTAINER): string {
  const clean = validateText('Distrobox container', container);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(clean)) throw new Error('Distrobox container name contains unsupported characters.');
  const descriptor = (binary: string): DesktopLaunchDescriptor => ({
    exe: 'distrobox',
    args: ['enter', '--name', clean, '--', binary],
  });
  const config: LinuxDesktopConfig = {
    version: 1,
    container: clean,
    apps: { claude: descriptor('claude-desktop'), codex: descriptor('chatgpt') },
  };
  atomicWriteFile(linuxDesktopConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 0o600);
  return linuxDesktopConfigPath();
}

function executableOnPath(exe: string): boolean {
  if (path.isAbsolute(exe) || /[\\/]/u.test(exe)) {
    try {
      fs.accessSync(exe, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return (process.env.PATH ?? '').split(path.delimiter).some((entry) => {
    if (!entry) return false;
    try {
      fs.accessSync(path.join(entry, exe), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function resolveLinuxDesktopLaunch(provider: DesktopProvider): DesktopLaunchDescriptor | null {
  if (process.platform !== 'linux') return null;
  const override = process.env[provider === 'claude' ? 'CLAUDE_DESKTOP_BIN' : 'CODEX_DESKTOP_BIN']?.trim();
  if (override) return validateDescriptor(provider, { exe: override, args: [] });
  const config = loadLinuxDesktopConfig();
  if (config) return config.apps[provider];
  const native = provider === 'claude' ? 'claude-desktop' : 'chatgpt';
  return executableOnPath(native) ? { exe: native, args: [] } : null;
}

function osReleaseLabel(): string {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const pretty = text.match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/mu);
    return pretty?.[1] ?? pretty?.[2] ?? 'Linux';
  } catch {
    return 'Linux';
  }
}

function commandResult(exe: string, args: string[]): { ok: boolean; detail: string } {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return {
    ok: result.status === 0,
    detail: String(result.stdout || result.stderr || result.error?.message || '').trim(),
  };
}

export function inspectLinuxDesktop(): LinuxDesktopDiagnostic {
  if (process.platform !== 'linux') return { ok: false, lines: ['Linux Desktop integration is only available on Linux.'] };
  const lines = [`Host: ${osReleaseLabel()}`];
  const distroboxAvailable = executableOnPath('distrobox');
  const podmanAvailable = executableOnPath('podman');
  lines.push(`Podman: ${podmanAvailable ? 'available' : 'missing'}`);
  lines.push(`Distrobox: ${distroboxAvailable ? 'available' : 'missing'}`);
  lines.push(`Session: ${process.env.WAYLAND_DISPLAY ? 'Wayland' : process.env.DISPLAY ? 'X11' : 'no graphical display detected'}`);

  let config: LinuxDesktopConfig | null = null;
  let containerExists = false;
  try {
    config = loadLinuxDesktopConfig();
    lines.push(`Launch configuration: ${config ? linuxDesktopConfigPath() : 'not configured'}`);
  } catch (error) {
    lines.push(`Launch configuration: invalid (${String((error as Error).message ?? error)})`);
  }
  if (config && distroboxAvailable) {
    const listed = commandResult('distrobox', ['list', '--no-color']);
    containerExists = listed.ok && listed.detail.split(/\r?\n/u).some((line) => line.includes(config!.container));
    lines.push(`Ubuntu 24.04 box "${config.container}": ${containerExists ? 'present' : 'not found'}`);
  }
  const appReady = new Map<DesktopProvider, boolean>();
  for (const provider of ['claude', 'codex'] as const) {
    try {
      const descriptor = resolveLinuxDesktopLaunch(provider);
      let ready = !!descriptor && executableOnPath(descriptor.exe);
      if (ready && config && descriptor?.exe === 'distrobox') {
        const binary = provider === 'claude' ? 'claude-desktop' : 'chatgpt';
        ready = containerExists
          && commandResult('distrobox', ['enter', '--name', config.container, '--', '/usr/bin/which', binary]).ok;
      }
      appReady.set(provider, ready);
      lines.push(`${provider === 'claude' ? 'Claude Desktop' : 'ChatGPT/Codex Desktop'} launcher: ${ready ? 'ready' : 'missing'}`);
    } catch (error) {
      lines.push(`${provider} launcher: invalid (${String((error as Error).message ?? error)})`);
    }
  }
  const bothAppsReady = (['claude', 'codex'] as const).every((provider) => appReady.get(provider) === true);
  const ok = bothAppsReady && (config ? podmanAvailable && distroboxAvailable && containerExists : true);
  return { ok, lines };
}

export function linuxDesktopGuide(container = DEFAULT_CONTAINER): string {
  const clean = validateText('Distrobox container', container);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(clean)) throw new Error('Distrobox container name contains unsupported characters.');
  return `CachyOS Desktop setup (commands are displayed, never run automatically)

1. Install host integration:
   sudo pacman -S --needed podman distrobox xdg-utils wl-clipboard desktop-file-utils

2. Create the supported Ubuntu base:
   distrobox create --name ${clean} --image ubuntu:24.04

3. Download the current official .deb packages from:
   Claude Desktop: https://code.claude.com/docs/en/desktop-linux
   ChatGPT/Codex:   https://learn.chatgpt.com/docs/linux/linux-app

4. Install the downloaded packages inside the box (replace the two paths):
   distrobox enter --name ${clean} -- sudo apt install /absolute/path/claude-desktop.deb /absolute/path/chatgpt.deb

5. Export both graphical applications to CachyOS:
   distrobox enter --name ${clean} -- distrobox-export --app claude-desktop
   distrobox enter --name ${clean} -- distrobox-export --app chatgpt

6. Register no-shell launch descriptors for safe account switching:
   node dist/cli.js linux-desktop configure ${clean}
   node dist/cli.js linux-desktop doctor

The Distrobox shares your home directory and Wayland/X11 integration. Sign in once in each
Linux Desktop app. Windows Chromium cookies are kept in the migration recovery archive but
are not injected into Linux because those sessions are machine/OS-bound.`;
}
