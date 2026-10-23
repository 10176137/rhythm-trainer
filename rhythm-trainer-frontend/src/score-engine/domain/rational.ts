/**
 * Exact musical time in quarter-note beats. All arithmetic is done on safe
 * integers; no accumulated floating point is allowed. A MusicXML duration is
 * normalized at read time with the divisions active at that point.
 */
export interface RationalBeat {
  readonly numerator: number;
  readonly denominator: number;
}

export class RationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RationalError';
  }
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RationalError(`${label} 必须是安全整数，收到 ${String(value)}`);
  }
}

export function rational(numerator: number, denominator = 1): RationalBeat {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  if (denominator === 0) throw new RationalError('分母不能为 0');
  if (denominator < 0) {
    numerator = -numerator;
    denominator = -denominator;
  }
  if (numerator === 0) return ZERO_BEAT;
  const factor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / factor, denominator: denominator / factor });
}

export const ZERO_BEAT: RationalBeat = Object.freeze({ numerator: 0, denominator: 1 });

export function addBeat(a: RationalBeat, b: RationalBeat): RationalBeat {
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function subtractBeat(a: RationalBeat, b: RationalBeat): RationalBeat {
  return rational(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function multiplyBeat(a: RationalBeat, multiplier: number | RationalBeat): RationalBeat {
  if (typeof multiplier === 'number') {
    assertSafeInteger(multiplier, 'multiplier');
    return rational(a.numerator * multiplier, a.denominator);
  }
  return rational(a.numerator * multiplier.numerator, a.denominator * multiplier.denominator);
}

export function compareBeat(a: RationalBeat, b: RationalBeat): number {
  return a.numerator * b.denominator - b.numerator * a.denominator;
}

export function beatsEqual(a: RationalBeat, b: RationalBeat): boolean {
  return compareBeat(a, b) === 0;
}

export function isZeroBeat(value: RationalBeat): boolean {
  return value.numerator === 0;
}

export function isNegativeBeat(value: RationalBeat): boolean {
  return value.numerator < 0;
}

export function maxBeat(a: RationalBeat, b: RationalBeat): RationalBeat {
  return compareBeat(a, b) >= 0 ? a : b;
}

export function minBeat(a: RationalBeat, b: RationalBeat): RationalBeat {
  return compareBeat(a, b) <= 0 ? a : b;
}

export function toNumber(value: RationalBeat): number {
  return value.numerator / value.denominator;
}

export function beatToString(value: RationalBeat): string {
  return `${value.numerator}/${value.denominator}`;
}

/** MusicXML duration units / divisions per quarter note. */
export function fromMusicXmlDuration(durationUnits: number, divisionsPerQuarter: number): RationalBeat {
  assertSafeInteger(durationUnits, 'duration');
  assertSafeInteger(divisionsPerQuarter, 'divisions');
  if (divisionsPerQuarter <= 0) throw new RationalError('divisions 必须为正整数');
  if (durationUnits < 0) throw new RationalError('duration 不能为负数');
  return rational(durationUnits, divisionsPerQuarter);
}

/** Converts a free numeric position to a rational with an explicit tick grid. */
export function fromTicks(ticks: number, ticksPerQuarter: number): RationalBeat {
  assertSafeInteger(ticks, 'ticks');
  assertSafeInteger(ticksPerQuarter, 'ticksPerQuarter');
  if (ticksPerQuarter <= 0) throw new RationalError('ticksPerQuarter 必须为正整数');
  return rational(ticks, ticksPerQuarter);
}

/** Exact conversion to a tick grid; returns null instead of silently rounding. */
export function toTicks(value: RationalBeat, ticksPerQuarter: number): number | null {
  const scaled = value.numerator * ticksPerQuarter;
  if (scaled % value.denominator !== 0) return null;
  const ticks = scaled / value.denominator;
  return Number.isSafeInteger(ticks) ? ticks : null;
}
