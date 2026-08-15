// ─── Speed baseline ────────────────────────────────────────────────
//
// A colour on a throughput number has to mean something, and "above 45
// tokens per second" does not. That threshold answers a question you can
// already answer — which model am I running — and says nothing on the
// hardware people actually serve on today, where every local model sits
// permanently in the top band.
//
// The question worth answering is the one you cannot: is this turn slower
// than this model normally runs? A server that picked up other traffic, a
// speculative-decoding setting that stopped paying off, a flag you changed
// an hour ago — those show up as a deviation from the model's own history
// and nowhere else.
//
// So the same trick as calibration: learn the normal rate per model from
// the turns that go past, and colour the deviation rather than the value.
//
// Two constants carry the design.
//
// SMOOTHING has to be slower than the signal it is a reference for. A
// baseline that chased every turn would sit on top of the current rate and
// the deviation would always read normal — the indicator would cancel
// itself out.
//
// DEVIATION_BAND has to sit outside ordinary content variation, or it fires
// on nothing. Measured across five content types on one server, decode rate
// ran 118.9 to 160.7 tok/s — a spread of 1.35x from content alone, with
// Chinese slowest because CJK gives a draft model less to predict. A band
// at 1.35 would light up every time the subject changed. At 1.5 it stays
// dark for that and still catches what matters: switching speculative
// decoding off was worth about 2x, and a server under load rather more.

/** What we have learned about a model's normal speed. */
export interface Baseline {
  /** Typical decode rate, tokens per second. */
  rate: number;
  /** Turns folded in. */
  samples: number;
}

export type Deviation = "slow" | "normal" | "fast";

const SMOOTHING = 0.15;
const DEVIATION_BAND = 1.5;

/**
 * Turns generating for less than this are not timed precisely enough for
 * their rate to mean anything.
 */
const MIN_SAMPLE_SECONDS = 1;

/**
 * A baseline of one sample is just "the previous turn", and comparing a
 * turn against the previous turn flags ordinary content variation as if it
 * were news. Three is enough for the average to outweigh any single one.
 */
const MIN_SAMPLES_TO_CLASSIFY = 3;

/**
 * Fold one finished turn into a model's baseline.
 *
 * Deliberately without the outlier rejection calibration uses: a genuinely
 * slow turn is the signal here, not noise to be filtered out. Smoothing
 * alone keeps one of them from moving the reference much, while a lasting
 * change still pulls it across within a handful of turns.
 */
export function observe(
  current: Baseline | undefined,
  rate: number,
  activeSeconds: number,
): Baseline | undefined {
  if (!Number.isFinite(rate) || rate <= 0) return current;
  if (activeSeconds < MIN_SAMPLE_SECONDS) return current;
  if (!current) return { rate, samples: 1 };

  return {
    rate: current.rate * (1 - SMOOTHING) + rate * SMOOTHING,
    samples: current.samples + 1,
  };
}

/**
 * Where this turn sits against the model's normal speed.
 *
 * Null until there is enough history to say — the same rule the rest of the
 * extension follows, that nothing is presented as known before it is.
 */
export function classify(rate: number, baseline: Baseline | undefined): Deviation | null {
  if (!baseline || baseline.samples < MIN_SAMPLES_TO_CLASSIFY) return null;
  if (!Number.isFinite(rate) || rate <= 0 || baseline.rate <= 0) return null;

  const ratio = rate / baseline.rate;
  if (ratio >= DEVIATION_BAND) return "fast";
  if (ratio <= 1 / DEVIATION_BAND) return "slow";
  return "normal";
}
