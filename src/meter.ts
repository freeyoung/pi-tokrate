// ─── Measurement ───────────────────────────────────────────────────
//
// Two numbers come out of a turn, and they are not the same measurement:
//
//   - the live rate, over a short trailing window, so the status bar moves
//     while the answer is being written. It has to be an estimate, because
//     nothing in the stream reports token counts until the end.
//   - the turn's rate, tokens over the time actually spent generating. Once
//     the provider's authoritative count lands, this is exact.
//
// The old plugin showed both through one code path, which meant the exact
// one inherited the estimate's error. Keeping them apart is what lets the
// final number be trusted even on a server the estimator reads badly.
//
// "Time actually spent generating" excludes the gaps where nothing is being
// generated: a tool running, a permission prompt waiting on a human, a
// build taking a minute. Including those would make tok/s a measure of how
// long the user took to hit Enter.
//
// Two things keep them out. The reliable one is markGenerationStart: the
// harness says when a span of generation begins, and the clock never spans
// that boundary, however brief the pause was. The fallback is IDLE_GAP_MS,
// for a stall inside a span that no event announces — a network hiccup, a
// server swapping a model back in. Real streams emit far faster than that
// threshold, so the only thing it can misjudge is a model slower than ~0.5
// tokens/second, where the rate is not interesting anyway.

import { estimateTokens } from "./estimate.ts";

/** A gap between deltas longer than this was not spent generating. */
const IDLE_GAP_MS = 2000;

/** Trailing window for the live rate. */
const WINDOW_MS = 1000;

interface Sample {
  at: number;
  tokens: number;
}

/** What a delta was: the model deliberating, or the model answering. */
export type DeltaKind = "thinking" | "output";

export class Meter {
  private samples: Sample[] = [];
  private estimated = 0;
  private estimatedThinking = 0;
  private actual: number | null = null;
  private activeMs = 0;
  private lastDeltaAt: number | null = null;
  private streaming = false;

  // Null rather than 0 for "not started": a timestamp of 0 is a legitimate
  // value, and treating it as absent silently drops time-to-first-token.
  private promptAt: number | null = null;
  private ttftMs: number | null = null;

  /** Begin a turn. Everything from the previous one is discarded. */
  reset(now: number = Date.now()): void {
    this.samples = [];
    this.estimated = 0;
    this.estimatedThinking = 0;
    this.actual = null;
    this.activeMs = 0;
    this.lastDeltaAt = null;
    this.streaming = false;
    this.promptAt = now;
    this.ttftMs = null;
  }

  /**
   * Note that a span of generation is beginning.
   *
   * Whatever happened before this — a tool running, a human approving one —
   * was not generation, so the clock does not carry across the boundary.
   * That is a stronger signal than the idle-gap heuristic below, which
   * cannot tell a half-second tool from a half-second of slow decoding.
   */
  markGenerationStart(now: number = Date.now()): void {
    this.streaming = true;
    this.lastDeltaAt = null;
    if (this.ttftMs === null && this.promptAt !== null) this.ttftMs = now - this.promptAt;
  }

  /**
   * Fold in one streamed delta.
   *
   * The gap since the previous delta is added to the active time, unless it
   * was long enough to have been a pause.
   */
  record(delta: string, kind: DeltaKind = "output", now: number = Date.now()): void {
    const tokens = estimateTokens(delta);
    if (tokens <= 0) return;

    if (this.ttftMs === null && this.promptAt !== null) this.ttftMs = now - this.promptAt;
    if (this.lastDeltaAt !== null) {
      const gap = now - this.lastDeltaAt;
      if (gap <= IDLE_GAP_MS) this.activeMs += gap;
    }
    this.lastDeltaAt = now;
    this.streaming = true;

    this.estimated += tokens;
    if (kind === "thinking") this.estimatedThinking += tokens;
    this.samples.push({ at: now, tokens });
    this.trim(now);
  }

  /** End the turn, adopting the provider's authoritative output count. */
  finish(actualTokens: number): void {
    this.streaming = false;
    if (Number.isFinite(actualTokens) && actualTokens > 0) this.actual = actualTokens;
  }

  private trim(now: number): void {
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < this.samples.length && this.samples[i].at < cutoff) i++;
    if (i > 0) this.samples = this.samples.slice(i);
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /** Raw estimated tokens this turn, before any calibration. */
  get estimatedTokens(): number {
    return this.estimated;
  }

  /**
   * The share of this turn's estimated tokens that went into thinking.
   *
   * A share rather than a count, because that is the part worth trusting.
   * Both halves come from the same estimator, so its bias largely cancels
   * in the ratio — and a share is what gets scaled against the provider's
   * authoritative total to recover counts.
   */
  get thinkingShare(): number {
    return this.estimated > 0 ? this.estimatedThinking / this.estimated : 0;
  }

  /** The provider's count, once the turn has ended. */
  get actualTokens(): number | null {
    return this.actual;
  }

  get ttft(): number | null {
    return this.ttftMs;
  }

  /** Seconds spent generating, excluding pauses. */
  get activeSeconds(): number {
    return this.activeMs / 1000;
  }

  /**
   * Estimated tokens inside the trailing window, and the span they cover.
   * Returns null until there is enough of a window to divide by.
   */
  windowRate(now: number = Date.now()): number | null {
    this.trim(now);
    if (this.samples.length < 2) return null;

    const span = this.samples[this.samples.length - 1].at - this.samples[0].at;
    if (span <= 0) return null;

    // The first sample's tokens arrived before the span opened, so counting
    // them would inflate the rate on a slow stream.
    let tokens = 0;
    for (let i = 1; i < this.samples.length; i++) tokens += this.samples[i].tokens;
    return (tokens / span) * 1000;
  }

  /**
   * The turn's overall rate, using the authoritative count when the turn has
   * finished and the estimate while it is still running.
   */
  turnRate(): number | null {
    if (this.activeMs <= 0) return null;
    const tokens = this.actual ?? this.estimated;
    if (tokens <= 0) return null;
    return tokens / this.activeSeconds;
  }
}
