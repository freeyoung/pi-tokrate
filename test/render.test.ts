import { describe, expect, it } from "vitest";
import { renderStatus, type Snapshot } from "../src/render.ts";
import { DEFAULT_DISPLAY, uniform, type Display } from "../src/display.ts";

// The two presets the old rate/full modes stood for, so these tests keep
// describing the compact line and the everything-on line.
const COMPACT: Display = { ...DEFAULT_DISPLAY };
const ALL: Display = uniform(true);
const mode = (m: "rate" | "full") => (m === "full" ? ALL : COMPACT);

const theme = { fg: (_style: string, text: string) => text };

const base: Snapshot = {
  rate: 110.7,
  measured: true,
  tokens: 1240,
  seconds: 11.2,
  ttft: 430,
  deviation: null,
  thinking: null,
  answer: null,
  budget: 65536,
};

const tagging = { fg: (style: string, text: string) => `<${style}>${text}</${style}>` };

const render = (over: Partial<Snapshot> = {}, display: "rate" | "full" = "rate") =>
  renderStatus({ ...base, ...over }, mode(display), theme) ?? "";

describe("renderStatus", () => {
  // The invariant that keeps the status line from corrupting the screen.
  //
  // Pi truncates the footer to the terminal width using its own width table,
  // and East Asian *Ambiguous* characters are where that table and a CJK
  // terminal part company: pi-tui counts one column, the terminal draws two.
  // The line then runs past the width it was truncated to, wraps, and each
  // repaint strands another row. Both halves of that bug shipped once — a
  // ◌◔◑◕● ramp and a U+00B7 separator — so the rule is enforced over the
  // whole rendered string rather than remembered per character.
  //
  // Anything not ASCII has to appear below, which is the point: adding a
  // character means measuring it first. Check a candidate with pi-tui's own
  // visibleWidth() — 2 means Wide and safe, 1 on a non-ASCII character means
  // Ambiguous and forbidden. ⏱ is the trap worth knowing about: it looks
  // like an emoji and measures 1.
  const MEASURED_WIDE = new Set(["🌕", "🌔", "🌓", "🌒", "🌑"]);

  it("emits nothing whose width a terminal could disagree about", () => {
    const shapes: Partial<Snapshot>[] = [
      {},
      { rate: null },
      { measured: false },
      { deviation: "slow" },
      { thinking: 900, answer: 100 },
      { thinking: 32768, answer: 0 },
      { thinking: 33000, answer: 0, measured: false },
    ];
    for (const shape of shapes) {
      for (const display of ["rate", "full"] as const) {
        const out = renderStatus({ ...base, ...shape }, mode(display), theme) ?? "";
        for (const char of out) {
          if (char >= " " && char <= "~") continue;
          expect(MEASURED_WIDE).toContain(char);
        }
      }
    }
  });

  it("shows a placeholder before anything has been measured", () => {
    expect(render({ rate: null })).toContain("--");
  });

  it("shows a plain rate once the turn is over", () => {
    expect(render()).toContain("111 tok/s");
  });

  // The rule the whole extension exists for: a derived number must not be
  // presentable as a measured one.
  it("marks a live rate as an estimate", () => {
    expect(render({ measured: false })).toContain("~");
  });

  it("drops the tilde only when the provider's own count is in hand", () => {
    expect(render({ measured: true })).not.toContain("~");
  });

  // A finished turn divides the provider's own count by a measured
  // duration. Neither term goes through the estimator, so how well the model
  // is calibrated has no bearing on it — an uncalibrated model has a shaky
  // live number and an exact final one, and marking the latter as a guess
  // would be its own kind of dishonesty.
  it("does not mark a finished turn as a guess", () => {
    expect(render({ measured: true })).not.toContain("~");
  });

  it("gives a slow rate a decimal and a fast one none", () => {
    expect(render({ rate: 8.25 })).toContain("8.3 tok/s");
    expect(render({ rate: 110.7 })).toContain("111 tok/s");
  });

  // The glyph is the one channel that costs no width, so it carries the
  // shape of the turn even when the compact display says nothing about it.
  describe("the leading glyph", () => {
    const glyph = (over: Partial<Snapshot>) => render(over).trim().split(" ")[0];

    it("is fully lit for a model that does not think out loud", () => {
      expect(glyph({ thinking: 0, answer: 1200 })).toBe("🌕");
      expect(glyph({ thinking: null, answer: null })).toBe("🌕");
    });

    // Lit is answer, dark is deliberation: a full moon delivered everything,
    // a new moon delivered nothing.
    it("darkens in step with the share spent thinking", () => {
      expect(glyph({ thinking: 100, answer: 900 })).toBe("🌔");
      expect(glyph({ thinking: 400, answer: 600 })).toBe("🌓");
      expect(glyph({ thinking: 700, answer: 300 })).toBe("🌒");
      expect(glyph({ thinking: 900, answer: 100 })).toBe("🌑");
    });

    // A reasoning turn is entirely thinking until it answers, and the glyph
    // emptying out is how that resolution reads at a glance.
    it("is fully dark while a turn has produced no answer yet", () => {
      expect(glyph({ thinking: 500, answer: 0 })).toBe("🌑");
    });

    // The bug this replaced: ◌◔◑◕● are East Asian Ambiguous, measured as one
    // column by pi-tui and drawn as two by a CJK terminal. The line then ran
    // one column past where Pi had truncated it, wrapped, and every repaint
    // stranded another row. Only ASCII is immune to that disagreement.
    it("still marks the shape when there is no rate to show", () => {
      expect(glyph({ rate: null, thinking: 900, answer: 100 })).toBe("🌑");
    });
  });

  // Rarity is an assumption about the model, not a guarantee: one that
  // habitually spends most of a turn deliberating would trip the notice
  // every time, and the threshold is deliberately not tunable.
  describe("with the alert switched off", () => {
    const quiet: Display = { ...DEFAULT_DISPLAY, alert: false };
    const loud: Display = { ...DEFAULT_DISPLAY };
    const at = (d: Display, over: Partial<Snapshot>) =>
      renderStatus({ ...base, ...over }, d, tagging) ?? "";

    it("drops the share warning a habitual thinker would trip every turn", () => {
      expect(at(loud, { thinking: 9000, answer: 1000 })).toContain("90% think");
      expect(at(quiet, { thinking: 9000, answer: 1000 })).not.toContain("think");
    });

    it("drops the mid-turn budget warning", () => {
      const running = { measured: false, thinking: 33000, answer: 0, budget: 65536 };
      expect(at(loud, running)).toContain("<warning>");
      expect(at(quiet, running)).not.toContain("<warning>");
    });

    it("stops shouting about a turn that answered nothing", () => {
      expect(at(loud, { thinking: 32768, answer: 0 })).toContain("<error>");
      expect(at(quiet, { thinking: 32768, answer: 0 })).not.toContain("<error>");
    });

    // Declining the alarm is not declining the accounting: with the split
    // on, the same fact is still reported, just without raising its voice.
    it("still reports an empty turn as detail when the split is on", () => {
      const withSplit: Display = { ...quiet, split: true };
      const out = at(withSplit, { thinking: 32768, answer: 0 });
      expect(out).toContain("no answer");
      expect(out).not.toContain("<error>");
    });

    it("leaves the moon alone, which carries the share regardless", () => {
      expect(at(quiet, { thinking: 9000, answer: 1000 })).toContain("🌑");
    });
  });

  // "Show me nothing" is unambiguous, and the failure notices — which
  // override every individual toggle — do not get to override it. Honouring
  // a request everywhere except one case is a promise the status bar breaks.
  describe("with every element switched off", () => {
    const OFF: Display = uniform(false);
    const off = (over: Partial<Snapshot> = {}) =>
      renderStatus({ ...base, ...over }, OFF, theme);

    it("clears the status entirely", () => {
      expect(off()).toBeUndefined();
    });

    it("stays silent even for a turn that produced no answer", () => {
      expect(off({ thinking: 32768, answer: 0 })).toBeUndefined();
    });

    it("stays silent even while thinking is eating the budget", () => {
      expect(off({ measured: false, thinking: 33000, answer: 0, budget: 65536 })).toBeUndefined();
    });
  });

  // The other half of the rule: the notices do override the ordinary
  // toggles, so the compact default still says when a turn came back empty.
  it("reports a failed turn even with the split switched off", () => {
    const out = renderStatus({ ...base, thinking: 32768, answer: 0 }, COMPACT, theme);
    expect(out).toContain("no answer");
  });

  describe("deviation colouring", () => {
    // The theme stub tags rather than colours, so these assert which
    // semantic colour was asked for rather than any escape sequence.
    const paint = (deviation: Snapshot["deviation"]) =>
      renderStatus({ ...base, deviation }, COMPACT, tagging) ?? "";

    it("leaves a normal turn uncoloured", () => {
      expect(paint("normal")).not.toContain("<success>");
      expect(paint("normal")).not.toContain("<warning>");
    });

    it("colours a turn above the model's usual rate", () => {
      expect(paint("fast")).toContain("<success>111 tok/s</success>");
    });

    // A slow turn is a notice, not a failure — the server is running, just
    // not the way it usually does.
    it("warns rather than errors on a slow turn", () => {
      expect(paint("slow")).toContain("<warning>111 tok/s</warning>");
      expect(paint("slow")).not.toContain("<error>");
    });

    it("leaves the rate alone when there is no baseline to compare against", () => {
      expect(paint(null)).toContain("111 tok/s");
      expect(paint(null)).not.toContain("<success>");
      expect(paint(null)).not.toContain("<warning>");
    });
  });

  // The part a throughput number cannot express: a reasoning model can burn
  // an entire budget deliberating and return nothing, and every rate reads
  // healthy while it happens.
  describe("where the turn went", () => {
    const shape = (
      over: Partial<Snapshot>,
      display: "rate" | "full" = "rate",
    ) => renderStatus({ ...base, ...over }, mode(display), tagging) ?? "";

    it("says nothing for a model that does not think out loud", () => {
      expect(shape({ thinking: 0, answer: 1200 })).not.toContain("think");
      expect(shape({ thinking: null, answer: null })).not.toContain("think");
    });

    it("stays quiet in compact mode at an ordinary thinking share", () => {
      expect(shape({ thinking: 300, answer: 900 })).not.toContain("think");
    });

    it("speaks up in compact mode once thinking has taken over", () => {
      expect(shape({ thinking: 9000, answer: 1000 })).toContain("<warning>90% think</warning>");
    });

    // The failure from a real session: 32768 tokens of deliberation, a
    // length stop, and not one token of answer.
    it("calls out a turn that produced no answer at all", () => {
      const out = shape({ thinking: 32768, answer: 0 });
      expect(out).toContain("<error>");
      expect(out).toContain("no answer");
      expect(out).toContain("33k");
    });

    it("always shows the split in full mode", () => {
      expect(shape({ thinking: 300, answer: 900 }, "full")).toContain("300 think + 900 out");
    });

    it("marks the split in full mode when thinking dominates", () => {
      expect(shape({ thinking: 9000, answer: 1000 }, "full")).toContain("<warning>");
    });

    // Waiting for the turn to end would hide a runaway for precisely as long
    // as it is still possible to do something about it.
    describe("while the turn is still running", () => {
      const live = (over: Partial<Snapshot>, display: "rate" | "full" = "rate") =>
        shape({ measured: false, ...over }, display);

      // Every reasoning turn is 100% thinking before it answers, so a share
      // threshold would fire on all of them. What matters is how much of the
      // output budget has gone, since the answer has to come out of the rest.
      it("stays quiet early in an ordinary reasoning turn", () => {
        expect(live({ thinking: 800, answer: 0, budget: 65536 })).not.toContain("think");
      });

      it("warns once thinking has eaten half the output budget", () => {
        expect(live({ thinking: 33000, answer: 0, budget: 65536 })).toContain("<warning>33k think");
      });

      it("cannot judge risk without knowing the budget, and says nothing", () => {
        expect(live({ thinking: 33000, answer: 0, budget: null })).not.toContain("<warning>");
      });

      it("shows the running count in full mode regardless", () => {
        expect(live({ thinking: 800, answer: 0, budget: 65536 }, "full")).toContain("800 think");
      });
    });
  });

  describe("full display", () => {
    it("adds the token count and elapsed generating time", () => {
      const out = render({}, "full");
      expect(out).toContain("1.2k tok in 11.2s");
    });

    it("adds time to first token", () => {
      expect(render({}, "full")).toContain("ttft 430 ms");
    });

    it("leaves out details it does not have", () => {
      const out = render({ tokens: null, ttft: null }, "full");
      expect(out).not.toContain("tok in");
      expect(out).not.toContain("ttft");
    });

    it("stays on one line in rate mode", () => {
      expect(render()).not.toContain("tok in");
    });
  });
});
