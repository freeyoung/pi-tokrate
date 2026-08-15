// ─── Self-calibration ──────────────────────────────────────────────
//
// The estimator in estimate.ts is a proxy, and every proxy has a scale
// error. What makes that fixable is that the true answer always arrives:
// each turn ends with an authoritative output-token count from the
// provider. Divide it by what we guessed and you have this model's
// correction factor, for free, without knowing why the guess was off.
//
// That is the whole design. It absorbs, in one number and without a single
// backend special case:
//
//   - speculative decoding batching several tokens into one chunk
//   - a server's --stream-interval doing the same
//   - a tokenizer that packs CJK harder or looser than we assumed
//   - a model whose vocabulary splits code differently
//
// A table of per-backend fudge factors would need all of that spelled out,
// and would rot the first time a server changed its defaults. This asks the
// server instead, once per turn, forever.
//
// The ratio is smoothed rather than replaced, because a single turn is a
// noisy sample: a short answer, an unusual content mix, or a turn that was
// mostly tool calls all pull it around. An EMA settles within a few turns
// and then tracks slow drift, which is the shape of the real signal.

/** A model's learned correction factor and how much evidence backs it. */
export interface Calibration {
  /** Multiply a raw estimate by this to get the corrected token count. */
  ratio: number;
  /** Turns folded in so far. Also gates whether the ratio is trustworthy. */
  samples: number;
}

/** Weight given to each new turn once the EMA is warm. */
const SMOOTHING = 0.3;

/**
 * Turns below this many estimated tokens are ignored — not because they are
 * biased, but because they are noisy. Both sides of the ratio count the
 * same thing (generated tokens; a chat template lives in the prompt, not
 * here), and measured against a real server the means agree: 0.96 over six
 * turns under 40 tokens against 1.03 over two turns near 200. What differs
 * is the scatter — a standard deviation of 0.16 against 0.004, because on a
 * ten-token answer a single misjudged punctuation mark is ten percent.
 * Folding that in would make the ratio jitter for reasons that have nothing
 * to do with the server.
 */
const MIN_SAMPLE_TOKENS = 40;

/**
 * A sample this far from the running ratio is treated as an artefact rather
 * than evidence. What produces one is a turn where the two sides stopped
 * describing the same tokens: an internal retry that streamed its text
 * twice while usage counted the final attempt once, or an extension that
 * started part way through a turn and missed the beginning of it. Kept
 * generous, because real drift between content types is well inside it —
 * the widest gap measured across code, prose, CJK, JSON and markdown was
 * fourteen percent.
 */
const OUTLIER_FACTOR = 4;

/** Ratios outside this range mean something is wrong with the inputs. */
const MIN_RATIO = 0.05;
const MAX_RATIO = 20;

/** The correction applied before any evidence has been collected. */
export const UNCALIBRATED: Calibration = { ratio: 1, samples: 0 };

/**
 * Fold one finished turn into a model's calibration.
 *
 * @param current   What we knew before this turn, or undefined for a new model.
 * @param estimated What the estimator totalled during the turn.
 * @param actual    The provider's authoritative output-token count.
 * @returns The updated calibration, or `current` unchanged when the sample
 *          carries no usable signal.
 */
export function fold(
  current: Calibration | undefined,
  estimated: number,
  actual: number,
): Calibration {
  const base = current ?? UNCALIBRATED;
  if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return base;
  if (estimated < MIN_SAMPLE_TOKENS || actual <= 0) return base;

  const observed = actual / estimated;
  if (observed < MIN_RATIO || observed > MAX_RATIO) return base;

  // The first real sample is worth more than a nudge: until it lands the
  // ratio is a placeholder, not a measurement, so it is adopted outright.
  if (base.samples === 0) return { ratio: observed, samples: 1 };

  const drift = observed / base.ratio;
  if (drift > OUTLIER_FACTOR || drift < 1 / OUTLIER_FACTOR) return base;

  return {
    ratio: base.ratio * (1 - SMOOTHING) + observed * SMOOTHING,
    samples: base.samples + 1,
  };
}

/**
 * Apply a calibration to a raw estimate.
 */
export function correct(estimate: number, calibration: Calibration | undefined): number {
  return estimate * (calibration ?? UNCALIBRATED).ratio;
}

/** Stable key for a model's calibration. */
export function modelKey(provider: string | undefined, id: string | undefined): string {
  return `${provider ?? "unknown"}/${id ?? "unknown"}`;
}
