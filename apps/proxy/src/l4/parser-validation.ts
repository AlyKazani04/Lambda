// F8 — differential parser validation: pure comparison logic.
//
// WHY THIS EXISTS
//   B2's hand-written packet parser is trusted by every later Track B analyser
//   (B4 retransmit, B5 RTT, B6 state machine, B7 reassembly). "I think it is
//   right" is not evidence. These functions turn one decoded frame and one
//   tshark reference row into a common shape and compare them field by field,
//   so a disagreement points straight at a bug in one implementation or the
//   other. tshark is the verifier, not the competitor.
//
//   This module is pure (no I/O) so it is unit-testable over known inputs.
//   tools/validate-parser.ts does the file reading and printing around it.
//
// NOT SHIPPED IN THE PROXY RUNTIME
//   This is dev-only validation tooling. tsconfig.build.json excludes it from
//   the proxy build; it is still typechecked, linted and unit-tested.

import type { ParsedPacket } from 'shared-types';

/** One frame's comparable fields, from either our parser or tshark. */
export interface ValidationRow {
  /** 1-based frame index in the capture file (tshark's frame.number). */
  frameNumber: number;
  /** Raw 9-bit TCP flags (NS bit included), as our parser stores them. */
  flags: number;
  /** Absolute sequence number — never tshark's relative default. */
  seq: number;
  /** Absolute acknowledgement number. */
  ack: number;
  /** Raw 16-bit window field, unscaled (tshark tcp.window_size_value). */
  window: number;
  /** MSS option value, or null when the option is absent. */
  mss: number | null;
  /** Window-scale shift count, or null when absent. */
  windowScale: number | null;
  /** TCP timestamp value (TSval), or null when absent. */
  tsVal: number | null;
  /** TCP timestamp echo reply (TSecr), or null when absent. */
  tsEcr: number | null;
  /** Capture timestamp in seconds since the epoch (fractional). */
  timeEpoch: number;
}

/**
 * tshark column order. MUST match the `-e` order in tools/validate-parser.sh.
 * Kept here so the reference-row parser and the shell stay in lockstep.
 */
export const TSHARK_COLUMNS = [
  'frame.number',
  'tcp.flags',
  'tcp.seq',
  'tcp.ack',
  'tcp.window_size_value',
  'tcp.options.mss_val',
  'tcp.options.wscale.shift',
  'tcp.options.timestamp.tsval',
  'tcp.options.timestamp.tsecr',
  'frame.time_epoch',
] as const;

/**
 * Timestamps are compared to microsecond tolerance, not exact equality:
 * frame.time_epoch is a float with more precision than our integer
 * seconds + microseconds can always round-trip identically.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 1e-6;

/** A single field that disagrees between our parser and tshark. */
export interface FieldDiscrepancy {
  frameNumber: number;
  field: string;
  ours: string;
  reference: string;
}

/** The result of comparing one whole capture, aligned by frame number. */
export interface CaptureComparison {
  /** Frames present on both sides that were compared. */
  matchedFrames: number;
  discrepancies: FieldDiscrepancy[];
  /** Frame numbers tshark decoded but our parser skipped. */
  missingInOurs: number[];
  /** Frame numbers our parser decoded but tshark did not return. */
  missingInReference: number[];
}

/** Format raw flags the way tshark prints them: 0x followed by 4 hex digits. */
export function formatFlags(raw: number): string {
  return `0x${(raw >>> 0).toString(16).padStart(4, '0')}`;
}

/** Project a parsed packet into the comparable row shape. */
export function rowFromPacket(
  packet: ParsedPacket,
  frameNumber: number,
  timeEpoch: number,
): ValidationRow {
  const { tcp } = packet;
  return {
    frameNumber,
    flags: tcp.flags.raw,
    seq: tcp.seq,
    ack: tcp.ack,
    window: tcp.window,
    mss: tcp.options.mss ?? null,
    windowScale: tcp.options.windowScale ?? null,
    tsVal: tcp.options.timestamps?.tsVal ?? null,
    tsEcr: tcp.options.timestamps?.tsEcr ?? null,
    timeEpoch,
  };
}

/** Parse a required integer column; null when blank or not a number. */
function requiredInt(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Parse an optional integer column; an empty cell means the option is absent. */
function optionalInt(text: string): number | null {
  return requiredInt(text);
}

/**
 * Parse one tab-separated tshark `-T fields` line into a row. Returns null for
 * a blank or short line. Column order is TSHARK_COLUMNS.
 */
export function rowFromTshark(fields: readonly string[]): ValidationRow | null {
  if (fields.length < TSHARK_COLUMNS.length) return null;

  const frameNumber = requiredInt(fields[0]!);
  const flagsText = fields[1]!.trim();
  const seq = requiredInt(fields[2]!);
  const ack = requiredInt(fields[3]!);
  const window = requiredInt(fields[4]!);
  const timeEpoch = requiredInt(fields[9]!);
  if (
    frameNumber === null ||
    flagsText === '' ||
    seq === null ||
    ack === null ||
    window === null ||
    timeEpoch === null
  ) {
    return null;
  }

  // tshark prints flags as 0x-prefixed hex; strip the prefix and read base 16.
  const flags = Number.parseInt(flagsText.replace(/^0x/i, ''), 16);
  if (!Number.isFinite(flags)) return null;

  return {
    frameNumber,
    flags,
    seq,
    ack,
    window,
    mss: optionalInt(fields[5]!),
    windowScale: optionalInt(fields[6]!),
    tsVal: optionalInt(fields[7]!),
    tsEcr: optionalInt(fields[8]!),
    timeEpoch,
  };
}

/** Render an optional number for a discrepancy report. */
function showOptional(value: number | null): string {
  return value === null ? '(absent)' : String(value);
}

/** Compare two rows for the same frame; empty array means they agree. */
export function compareRows(
  ours: ValidationRow,
  reference: ValidationRow,
): FieldDiscrepancy[] {
  const discrepancies: FieldDiscrepancy[] = [];
  const report = (field: string, ourValue: string, refValue: string): void => {
    discrepancies.push({
      frameNumber: ours.frameNumber,
      field,
      ours: ourValue,
      reference: refValue,
    });
  };

  // Exact integer fields. Flags are shown in tshark's hex form for readability.
  if (ours.flags !== reference.flags) {
    report('flags', formatFlags(ours.flags), formatFlags(reference.flags));
  }
  if (ours.seq !== reference.seq) report('seq', String(ours.seq), String(reference.seq));
  if (ours.ack !== reference.ack) report('ack', String(ours.ack), String(reference.ack));
  if (ours.window !== reference.window) {
    report('window', String(ours.window), String(reference.window));
  }

  // Optional fields: absent must match absent, present must match present.
  if (ours.mss !== reference.mss) report('mss', showOptional(ours.mss), showOptional(reference.mss));
  if (ours.windowScale !== reference.windowScale) {
    report('windowScale', showOptional(ours.windowScale), showOptional(reference.windowScale));
  }
  if (ours.tsVal !== reference.tsVal) {
    report('tsVal', showOptional(ours.tsVal), showOptional(reference.tsVal));
  }
  if (ours.tsEcr !== reference.tsEcr) {
    report('tsEcr', showOptional(ours.tsEcr), showOptional(reference.tsEcr));
  }

  // Timestamp: microsecond tolerance, not exact equality.
  if (Math.abs(ours.timeEpoch - reference.timeEpoch) > TIMESTAMP_TOLERANCE_SECONDS) {
    report('timeEpoch', ours.timeEpoch.toFixed(9), reference.timeEpoch.toFixed(9));
  }

  return discrepancies;
}

/** Compare two whole captures, aligning rows by frame number. */
export function compareCaptures(
  ours: readonly ValidationRow[],
  reference: readonly ValidationRow[],
): CaptureComparison {
  const oursByFrame = new Map(ours.map((row) => [row.frameNumber, row]));
  const referenceByFrame = new Map(reference.map((row) => [row.frameNumber, row]));

  const discrepancies: FieldDiscrepancy[] = [];
  const missingInOurs: number[] = [];
  const missingInReference: number[] = [];
  let matchedFrames = 0;

  // Walk the union of frame numbers in sorted order for a deterministic report.
  const frameNumbers = [...new Set([...oursByFrame.keys(), ...referenceByFrame.keys()])].sort(
    (a, b) => a - b,
  );
  for (const frameNumber of frameNumbers) {
    const ourRow = oursByFrame.get(frameNumber);
    const refRow = referenceByFrame.get(frameNumber);
    if (ourRow === undefined) {
      missingInOurs.push(frameNumber);
      continue;
    }
    if (refRow === undefined) {
      missingInReference.push(frameNumber);
      continue;
    }
    matchedFrames += 1;
    discrepancies.push(...compareRows(ourRow, refRow));
  }

  return { matchedFrames, discrepancies, missingInOurs, missingInReference };
}
