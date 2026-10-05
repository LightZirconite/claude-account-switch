// Pure animation helpers for the Ink TUI. Every frame helper returns fixed-width text so
// animated cells never shift the layout, and every helper has a static form used when
// motion is disabled (non-TTY, CI, TERM=dumb, NO_COLOR, NO_ANIMATION or REDUCE_MOTION).

export interface MotionPolicy {
  /** Timers may run and frames may change. */
  animate: boolean;
  /** The terminal is expected to render braille spinner glyphs. */
  unicode: boolean;
}

type Env = Record<string, string | undefined>;

function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

export function resolveMotionPolicy(env: Env, isTTY: boolean, platform: NodeJS.Platform | string): MotionPolicy {
  const animate = isTTY
    && !flagEnabled(env.CI)
    && env.TERM !== 'dumb'
    // https://no-color.org: any non-empty value disables color, so decorative motion goes too.
    && !(env.NO_COLOR !== undefined && env.NO_COLOR !== '')
    && !flagEnabled(env.NO_ANIMATION)
    && !flagEnabled(env.REDUCE_MOTION);
  // The legacy Windows console host and the Linux virtual console usually lack braille
  // glyphs; Windows Terminal, VS Code, ConEmu and xterm-compatible terminals have them.
  const legacyWindowsConsole = platform === 'win32'
    && !env.WT_SESSION
    && !env.TERM_PROGRAM
    && env.ConEmuANSI !== 'ON'
    && !(env.TERM ?? '').startsWith('xterm');
  const unicode = !legacyWindowsConsole && env.TERM !== 'linux';
  return { animate, unicode };
}

export const SPINNER_INTERVAL_MS = 100;
export const UNICODE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const ASCII_SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;
export const STATIC_SPINNER_GLYPH = '•';
export const STATIC_SPINNER_GLYPH_ASCII = '*';

export function spinnerFrameCount(policy: MotionPolicy): number {
  if (!policy.animate) return 1;
  return policy.unicode ? UNICODE_SPINNER_FRAMES.length : ASCII_SPINNER_FRAMES.length;
}

/** One-column spinner glyph for a tick; constant when motion is disabled. */
export function spinnerGlyph(tick: number, policy: MotionPolicy): string {
  if (!policy.animate) return policy.unicode ? STATIC_SPINNER_GLYPH : STATIC_SPINNER_GLYPH_ASCII;
  const frames = policy.unicode ? UNICODE_SPINNER_FRAMES : ASCII_SPINNER_FRAMES;
  const index = ((Math.trunc(tick) % frames.length) + frames.length) % frames.length;
  return frames[index];
}

export interface ProgressCount {
  completed: number;
  total: number;
}

/** Reads a trailing "n/m" counter from a busy label such as "Refreshing usage… 3/7". */
export function progressFromLabel(label: string | null | undefined): ProgressCount | null {
  const match = /(\d+)\s*\/\s*(\d+)\s*$/.exec(label ?? '');
  if (!match) return null;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total <= 0) return null;
  return { completed: Math.min(completed, total), total };
}

/** Fixed-width determinate progress bar; always exactly `width` cells. */
export function progressBar(completed: number, total: number, width = 10): string {
  const cells = Math.max(1, Math.trunc(width));
  const ratio = total > 0 && Number.isFinite(completed) ? Math.max(0, Math.min(1, completed / total)) : 0;
  const filled = Math.round(ratio * cells);
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

// Selection focus: the cursor arrives as a light chevron and settles to the bold one.
export const CURSOR_SETTLE_MS = 90;
export const CURSOR_ARRIVING = '› ';
export const CURSOR_SETTLED = '❯ ';

/** Two-column cursor glyph. `settled` is false only during the brief arrival frame. */
export function cursorGlyph(settled: boolean, policy: MotionPolicy): string {
  return !policy.animate || settled ? CURSOR_SETTLED : CURSOR_ARRIVING;
}

// Switch feedback: the switched row's status cell flashes a highlighted checkmark (or
// cross on failure) and then fades back. Reduced motion shows one static mark instead.
export type FlashTone = 'success' | 'error';
export const FLASH_STEP_MS = 120;
export const FLASH_STEPS = 10;
export const STATIC_FLASH_MS = 1500;

export interface FlashFrame {
  glyph: string;
  /** Highlight (inverse) the cell on this frame. */
  highlight: boolean;
  bold: boolean;
}

export function flashFrame(step: number, tone: FlashTone, policy: MotionPolicy): FlashFrame | null {
  if (step < 0 || step >= FLASH_STEPS) return null;
  const glyph = tone === 'success' ? '✓' : '✗';
  if (!policy.animate) return { glyph, highlight: false, bold: true };
  // Two quick pulses, then a steady mark that settles before the flash ends.
  const highlight = step === 0 || step === 1 || step === 3;
  return { glyph, highlight, bold: step < FLASH_STEPS - 3 };
}

/** Number of timer ticks the flash needs and their period. */
export function flashSchedule(policy: MotionPolicy): { steps: number; intervalMs: number } {
  return policy.animate
    ? { steps: FLASH_STEPS, intervalMs: FLASH_STEP_MS }
    : { steps: 1, intervalMs: STATIC_FLASH_MS };
}

// Result title: the mark is revealed in three quick steps (· • ✓).
export const REVEAL_STEP_MS = 70;
export function revealGlyph(step: number, tone: FlashTone, policy: MotionPolicy): string {
  const final = tone === 'success' ? '✓' : '✗';
  if (!policy.animate || step >= 2) return final;
  return step <= 0 ? '·' : '•';
}

/** Policy for this process; the environment and stdout capability do not change while the TUI runs. */
export const MOTION: MotionPolicy = resolveMotionPolicy(process.env, Boolean(process.stdout.isTTY), process.platform);
