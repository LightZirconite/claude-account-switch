// Animated Ink cells. Each owns its timer so a frame re-renders only that cell, clears
// the timer on unmount, and starts no timer at all when motion is disabled.
import { useEffect, useState } from 'react';
import { Text } from 'ink';
import {
  CURSOR_SETTLE_MS,
  cursorGlyph,
  flashFrame,
  flashSchedule,
  MOTION,
  progressBar,
  progressFromLabel,
  REVEAL_STEP_MS,
  revealGlyph,
  SPINNER_INTERVAL_MS,
  spinnerFrameCount,
  spinnerGlyph,
  type FlashTone,
  type MotionPolicy,
} from './motion';

// A tiny spinner (no extra dependency). Labels ending in "n/m" also get a fixed-width
// progress bar. With motion disabled the glyph is static.
export function Spinner({
  label,
  color = 'cyanBright',
  policy = MOTION,
}: {
  label?: string;
  color?: string;
  policy?: MotionPolicy;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!policy.animate) return undefined;
    const frames = spinnerFrameCount(policy);
    const timer = setInterval(() => setTick((value) => (value + 1) % frames), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [policy]);
  const progress = progressFromLabel(label);
  return (
    <Text color={color} wrap="truncate-end">
      {spinnerGlyph(tick, policy)}
      {progress ? ` ${progressBar(progress.completed, progress.total, 10)}` : ''}
      {label ? ` ${label}` : ''}
    </Text>
  );
}

// Mounted on the newly selected row: arrives as a light chevron, then settles.
export function CursorMark({
  color,
  idleFrame,
  policy = MOTION,
}: {
  color: string;
  idleFrame: number;
  policy?: MotionPolicy;
}) {
  const [settled, setSettled] = useState(!policy.animate);
  useEffect(() => {
    if (!policy.animate) return undefined;
    const timer = setTimeout(() => setSettled(true), CURSOR_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [policy]);
  // After settling, keep the existing slow idle pulse of the selection chevron.
  const glyph = settled && idleFrame % 2 === 1 ? '› ' : cursorGlyph(settled, policy);
  return <Text color={color} bold>{glyph}</Text>;
}

// One-column status cell that briefly highlights the account a switch just targeted.
// The timer starts on mount (when the list becomes visible again) and calls onDone once.
export function SwitchFlashMark({
  tone,
  onDone,
  policy = MOTION,
}: {
  tone: FlashTone;
  onDone: () => void;
  policy?: MotionPolicy;
}) {
  const [step, setStep] = useState(0);
  const { steps, intervalMs } = flashSchedule(policy);
  useEffect(() => {
    if (step >= steps) {
      onDone();
      return undefined;
    }
    const timer = setTimeout(() => setStep((value) => value + 1), intervalMs);
    return () => clearTimeout(timer);
  }, [step, steps, intervalMs, onDone]);
  const frame = flashFrame(step, tone, policy);
  if (!frame) return <Text> </Text>;
  const color = tone === 'success' ? 'greenBright' : 'redBright';
  return frame.highlight
    ? <Text bold color="black" backgroundColor={color}>{frame.glyph}</Text>
    : <Text bold={frame.bold} color={color}>{frame.glyph}</Text>;
}

// Result-title mark (· • ✓ or · • ✗) followed by one space.
export function RevealMark({
  tone,
  color,
  policy = MOTION,
}: {
  tone: FlashTone;
  color: string;
  policy?: MotionPolicy;
}) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!policy.animate || step >= 2) return undefined;
    const timer = setTimeout(() => setStep((value) => value + 1), REVEAL_STEP_MS);
    return () => clearTimeout(timer);
  }, [step, policy]);
  return <Text bold color={color}>{revealGlyph(step, tone, policy)} </Text>;
}
