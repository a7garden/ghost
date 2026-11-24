import type { CallLevels } from './call-state';

export const SILENT: CallLevels = { input: 0, output: 0 };

/** Root-mean-square of float or PCM16 samples, scaled to 0..1. */
export function rms(samples: ArrayLike<number>, full = 1): number {
  let sum = 0;
  for (let index = 0; index < samples.length; index++) sum += samples[index]! * samples[index]!;
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length) / full;
}

/** Speech sits around 0.02–0.15 RMS; this lifts that range to use most of 0..1 without clipping a shout. */
export function shapeLevel(level: number): number {
  return Math.min(1, Math.min(1, level * 6) ** 0.6);
}

/** Instant attack, exponential release: a bar that rises with each syllable and settles between them. */
export class LevelMeter {
  private value = 0;
  private at = 0;

  push(level: number, now = performance.now()) {
    this.value = Math.max(shapeLevel(level), this.read(now));
    this.at = now;
  }

  read(now = performance.now()): number {
    return this.value * Math.exp(-Math.max(0, now - this.at) / 160);
  }
}

/** True while `level` stays above `threshold`, and for `hold` ms after it last was. */
export class Hysteresis {
  private last = -Infinity;

  constructor(private readonly threshold: number, private readonly hold: number) {}

  update(level: number, now = performance.now()): boolean {
    if (level >= this.threshold) this.last = now;
    return now - this.last <= this.hold;
  }
}
