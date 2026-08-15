// ─── Status bar ────────────────────────────────────────────────────
//
// One rule: a number that was derived is marked as derived.
//
// While a turn is streaming, the rate is an estimate corrected by a learned
// ratio, and it wears a tilde. When the turn ends and the provider's own
// token count arrives, the tilde goes away, because at that point the
// number is measured rather than inferred.
//
// This is a small thing that turns out to matter. An earlier attempt at
// comparing two server configurations was ruled invalid by exactly this
// gap: the status bar was showing decode steps per second while presenting
// them to one decimal place, indistinguishable from a real measurement, and
// the comparison quietly went the wrong way. A tilde would have stopped it.

import type { Deviation } from "./baseline.ts";
import { ELEMENTS, type Display } from "./display.ts";

export interface Theme {
  fg(style: string, text: string): string;
}

/**
 * Semantic theme colours rather than fixed hex, so the indicator follows
 * whatever palette the user chose instead of assuming a dark terminal.
 *
 * A slow turn is a notice, not a failure, so it is "warning" and not
 * "error" — nothing has gone wrong, the server is just not running the way
 * it usually does. "normal" gets no colour at all: it is the absence of
 * news, and colouring it would spend the reader's attention on nothing.
 */
const DEVIATION_COLOUR: Record<Deviation, string | null> = {
  slow: "warning",
  normal: null,
  fast: "success",
};

export interface Snapshot {
  rate: number | null;
  /**
   * Whether the rate came from the provider's own token count rather than
   * from reading the stream.
   *
   * Note this does not depend on how well calibrated the model is. A
   * finished turn divides an authoritative count by a measured duration,
   * and neither term goes through the estimator — a poorly calibrated model
   * has a shaky *live* number and an exact final one.
   */
  measured: boolean;
  tokens: number | null;
  seconds: number;
  ttft: number | null;
  /**
   * How this turn compares to the model's usual speed, or null when there
   * is not enough history to say. Only ever set for a finished turn: the
   * live rate is an estimate over a one-second window, and colouring that
   * would flicker between states on nothing but sampling noise.
   */
  deviation: Deviation | null;
  /**
   * Tokens the model spent deliberating rather than answering, and what was
   * left for the answer. Null on a model that does not think out loud.
   */
  thinking: number | null;
  answer: number | null;
  /**
   * The model's output ceiling, when known. Thinking and the answer come out
   * of this same budget, which is what makes a running thinking count worth
   * watching rather than merely interesting.
   */
  budget: number | null;
}

/**
 * On a finished turn, thinking past this share of the total was the story
 * rather than a detail.
 */
const THINKING_IS_THE_STORY = 0.75;

/**
 * On a turn still running, the useful alarm is not a share — every reasoning
 * turn is 100% thinking before it answers — but how much of the output
 * budget deliberation has already eaten. Past half, finishing the thought
 * and writing an answer within the remainder is in doubt.
 */
const BUDGET_AT_RISK = 0.5;

/**
 * The leading glyph is not decoration: its fill is the share of the turn
 * that went into thinking.
 *
 * It costs no width, which is what makes it worth doing. The compact
 * display only spells the share out once thinking has taken the turn over,
 * so below that the glyph is the only place the shape shows — and watching
 * it go from full to empty as an answer arrives is the same information a
 * sentence would carry, without the sentence.
 *
 * Empty means no deliberation at all, which is every turn on a model that
 * does not think out loud.
 *
 * Every one of these is East Asian *Wide*, which is the property that
 * matters — not whether it is ASCII.
 *
 * The first attempt used ◌◔◑◕●, which are *Ambiguous*: Pi's width table
 * counts them as one column while a terminal configured for CJK draws them
 * in two. The status line then ran a column past the width Pi had truncated
 * it to, wrapped, and every repaint stranded another row on screen. Wide
 * characters carry no such disagreement — both sides count two — so they
 * are as safe here as plain ASCII, and considerably easier to read.
 *
 * The lit part is the answer — what the turn actually delivered — and the
 * dark part is deliberation, paid for and never seen. So a turn that
 * answered in full is a full moon, and one that thought itself into
 * silence is a new moon: nothing delivered, nothing lit. Running it the
 * other way round would draw the cost as if it were the yield.
 *
 * Phases rather than a colour ramp for a second reason: the rate beside
 * this already carries a colour, for speed against the model's baseline.
 * Two colour scales on one line invite reading a red circle as "slow" when
 * it means "mostly thinking". Fullness is a separate channel from hue.
 *
 * Anything added to this ramp has to be measured before it is used. See the
 * width guard in the render tests.
 */
const SHARE_GLYPHS = ["🌔", "🌓", "🌒", "🌑"] as const;
const NO_THINKING = "🌕";

function glyphFor(thinking: number | null, answer: number | null): string {
  if (thinking === null || thinking <= 0) return NO_THINKING;
  const total = thinking + (answer ?? 0);
  if (total <= 0) return NO_THINKING;
  const share = thinking / total;
  const index = Math.min(SHARE_GLYPHS.length - 1, Math.ceil(share * SHARE_GLYPHS.length) - 1);
  return SHARE_GLYPHS[Math.max(0, index)];
}

function formatRate(rate: number, measured: boolean): string {
  const value = rate >= 100 ? rate.toFixed(0) : rate.toFixed(1);
  return `${measured ? "" : "~"}${value} tok/s`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  // A tenth of a thousand is a real distinction at 1.2k and noise at 33.0k.
  return tokens < 10_000 ? `${(tokens / 1000).toFixed(1)}k` : `${Math.round(tokens / 1000)}k`;
}

/**
 * Build the status bar text.
 *
 * Kept free of Pi's context so it can be tested directly; the caller passes
 * the theme in and hands the result to ctx.ui.setStatus.
 */
export function renderStatus(snapshot: Snapshot, display: Display, theme: Theme): string | undefined {
  // Everything off means everything off, including the failure notices.
  // They override the individual toggles — a turn that answered nothing is
  // worth a line whatever else is switched off — but not this, because
  // "show me nothing" is an unambiguous request and honouring it everywhere
  // except one case is just a promise the status bar breaks.
  if (ELEMENTS.every((element) => !display[element])) return undefined;

  const parts: string[] = [];

  // Dim, so it reads as a state marker rather than competing with the
  // deviation colour on the rate beside it.
  if (display.moon) parts.push(theme.fg("dim", glyphFor(snapshot.thinking, snapshot.answer)));

  if (display.rate) {
    if (snapshot.rate === null) {
      parts.push("--");
    } else {
      const rate = formatRate(snapshot.rate, snapshot.measured);
      const colour = snapshot.deviation ? DEVIATION_COLOUR[snapshot.deviation] : null;
      parts.push(colour ? theme.fg(colour, rate) : rate);
    }
  }

  const think = renderThinking(snapshot, display, theme);
  if (think) parts.push(think);

  const detail: string[] = [];
  if (display.tokens && snapshot.tokens !== null && snapshot.seconds > 0) {
    detail.push(`${formatTokens(snapshot.tokens)} tok in ${snapshot.seconds.toFixed(1)}s`);
  }
  if (display.ttft && snapshot.ttft !== null) detail.push(`ttft ${snapshot.ttft} ms`);
  // Comma, not a middle dot: U+00B7 is Ambiguous width, and it was the
  // second half of the same wrapping bug — the detail carried both it and
  // the glyph, drifting two columns instead of one.
  if (detail.length > 0) parts.push(theme.fg("dim", `(${detail.join(", ")})`));

  // Everything switched off clears the status rather than leaving a stub.
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * The part no throughput number can tell you: where the turn went.
 *
 * A reasoning model can spend an entire budget deliberating and return
 * nothing, and every rate in the world reads healthy while it happens —
 * the tokens are real, they are fast, and none of them is an answer. That
 * failure is invisible to a status bar that only reports speed, which is
 * why this one says it out loud.
 *
 * Compact mode stays quiet at ordinary thinking shares and speaks up when
 * thinking has taken over, so the line only lengthens when it has something
 * to report. Full mode always shows the split.
 */
function renderThinking(snapshot: Snapshot, display: Display, theme: Theme): string | null {
  const { thinking, answer, budget, measured } = snapshot;
  if (thinking === null || answer === null || thinking <= 0) return null;

  // Still running: the question is whether there will be budget left to
  // answer with, and the only way to see that coming is while it happens.
  if (!measured) {
    const atRisk =
      display.alert && budget !== null && budget > 0 && thinking >= budget * BUDGET_AT_RISK;
    const text = `${formatTokens(thinking)} think`;
    if (atRisk) return theme.fg("warning", text);
    return display.split ? theme.fg("dim", text) : null;
  }

  // Finished: every token deliberated, none delivered. Still a fact worth
  // stating with the alert off — it is only the alarm that was declined,
  // not the accounting — so it survives as detail if the split is on.
  if (answer <= 0) {
    const text = `${formatTokens(thinking)} think, no answer`;
    if (display.alert) return theme.fg("error", text);
    return display.split ? theme.fg("dim", text) : null;
  }

  const share = thinking / (thinking + answer);
  const loud = display.alert && share >= THINKING_IS_THE_STORY;
  if (display.split) {
    const text = `${formatTokens(thinking)} think + ${formatTokens(answer)} out`;
    return loud ? theme.fg("warning", text) : theme.fg("dim", text);
  }
  return loud ? theme.fg("warning", `${Math.round(share * 100)}% think`) : null;
}
