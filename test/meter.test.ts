import { describe, expect, it } from "vitest";
import { Meter } from "../src/meter.ts";

// A word scores one token, so a delta of N words is N estimated tokens.
// That keeps these tests about timing rather than about estimation.
const WORD = "alpha ";

function stream(meter: Meter, words: number, startAt: number, gapMs: number): number {
  let t = startAt;
  for (let i = 0; i < words; i++) {
    t += gapMs;
    meter.record(WORD, "output", t);
  }
  return t;
}

describe("Meter", () => {
  it("reports nothing before any delta arrives", () => {
    const meter = new Meter();
    meter.reset(0);
    expect(meter.windowRate(100)).toBeNull();
    expect(meter.turnRate()).toBeNull();
  });

  it("measures the turn rate over active time", () => {
    const meter = new Meter();
    meter.reset(0);
    stream(meter, 20, 0, 50); // 20 tokens, 50ms apart -> ~1s of generation
    expect(meter.activeSeconds).toBeCloseTo(0.95, 2);
    expect(meter.turnRate()).toBeCloseTo(20 / 0.95, 0);
  });

  // The number that matters: a tool run, or a human deciding whether to
  // approve one, is not the model generating slowly.
  it("excludes a long pause from the generating time", () => {
    const meter = new Meter();
    meter.reset(0);
    let t = stream(meter, 10, 0, 50);
    t += 60_000; // a minute of test suite
    stream(meter, 10, t, 50);

    expect(meter.activeSeconds).toBeLessThan(1.1);
    expect(meter.turnRate()).toBeGreaterThan(15);
  });

  it("counts an ordinary inter-delta gap as generating time", () => {
    const meter = new Meter();
    meter.reset(0);
    stream(meter, 5, 0, 1500); // slow, but still streaming
    expect(meter.activeSeconds).toBeCloseTo(6, 1);
  });

  // The idle-gap threshold cannot tell a fast tool from slow decoding, but
  // the harness announces where a new span of generation begins, and the
  // clock must not carry across that boundary however brief the pause was.
  it("excludes a pause too short for the idle threshold to catch", () => {
    const meter = new Meter();
    meter.reset(0);
    let t = stream(meter, 10, 0, 50);

    t += 900; // a tool that ran quickly — well under IDLE_GAP_MS
    meter.markGenerationStart(t);
    stream(meter, 10, t, 50);

    // Two spans of ~0.5s each, and nothing from the 0.9s between them.
    expect(meter.activeSeconds).toBeCloseTo(0.95, 1);
  });

  it("prefers the provider's count over its own estimate once finished", () => {
    const meter = new Meter();
    meter.reset(0);
    stream(meter, 20, 0, 50);
    meter.finish(54); // the server actually produced 54
    expect(meter.actualTokens).toBe(54);
    expect(meter.turnRate()).toBeCloseTo(54 / meter.activeSeconds, 3);
  });

  it("keeps its estimate when the provider reports no usage", () => {
    const meter = new Meter();
    meter.reset(0);
    stream(meter, 20, 0, 50);
    meter.finish(0);
    expect(meter.actualTokens).toBeNull();
    expect(meter.turnRate()).toBeCloseTo(20 / meter.activeSeconds, 3);
  });

  describe("live window", () => {
    it("reflects the recent rate, not the whole turn", () => {
      const meter = new Meter();
      meter.reset(0);
      stream(meter, 20, 0, 100); // slow first: ~10 tok/s, ends at t=2000
      const fast = stream(meter, 40, 2000, 10); // then ~100 tok/s

      const rate = meter.windowRate(fast);
      const turn = meter.turnRate();
      expect(rate).not.toBeNull();
      expect(turn).not.toBeNull();
      // The window still straddles the tail of the slow phase, so it lands
      // between the two rates — the point is that it has left the average
      // behind rather than that it has reached the new rate.
      expect(rate!).toBeGreaterThan(turn! * 1.5);
    });

    it("goes quiet once the window empties", () => {
      const meter = new Meter();
      meter.reset(0);
      const end = stream(meter, 10, 0, 50);
      expect(meter.windowRate(end + 5000)).toBeNull();
    });
  });

  describe("time to first token", () => {
    it("spans from the user's message to the first delta", () => {
      const meter = new Meter();
      meter.reset(1000);
      meter.record(WORD, "output", 3500);
      expect(meter.ttft).toBe(2500);
    });

    it("is unaffected by later deltas", () => {
      const meter = new Meter();
      meter.reset(0);
      meter.record(WORD, "output", 800);
      meter.record(WORD, "output", 5000);
      expect(meter.ttft).toBe(800);
    });

    // A whitespace-only delta is not the answer starting.
    it("ignores a delta carrying no tokens", () => {
      const meter = new Meter();
      meter.reset(0);
      meter.record("   ", "output", 500);
      expect(meter.ttft).toBeNull();
      meter.record(WORD, "output", 900);
      expect(meter.ttft).toBe(900);
    });
  });
});
