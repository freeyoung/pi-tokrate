import { describe, expect, it } from "vitest";
import { classify, observe } from "../src/baseline.ts";

describe("observe", () => {
  it("adopts the first usable turn outright", () => {
    expect(observe(undefined, 110, 12)).toEqual({ rate: 110, samples: 1 });
  });

  // A reference that chased every turn would sit on top of the current rate
  // and every turn would read normal — the indicator would cancel itself.
  it("moves slowly enough to stay a reference", () => {
    const after = observe({ rate: 110, samples: 5 }, 220, 12)!;
    expect(after.rate).toBeLessThan(130);
    expect(after.samples).toBe(6);
  });

  it("follows a lasting change within a handful of turns", () => {
    let b = observe(undefined, 110, 12);
    for (let i = 0; i < 15; i++) b = observe(b, 220, 12);
    expect(b!.rate).toBeGreaterThan(190);
  });

  // Unlike calibration, no outlier rejection: a genuinely slow turn is the
  // signal this exists to surface, not noise to be filtered out.
  it("learns from a slow turn instead of rejecting it", () => {
    const after = observe({ rate: 110, samples: 5 }, 20, 12)!;
    expect(after.rate).toBeLessThan(110);
    expect(after.samples).toBe(6);
  });

  it("ignores a turn too brief to have been timed properly", () => {
    const before = { rate: 110, samples: 5 };
    expect(observe(before, 400, 0.3)).toBe(before);
  });

  it("ignores a nonsense rate", () => {
    const before = { rate: 110, samples: 5 };
    expect(observe(before, 0, 12)).toBe(before);
    expect(observe(before, Number.NaN, 12)).toBe(before);
  });
});

describe("classify", () => {
  const settled = { rate: 110, samples: 8 };

  it("says nothing without a baseline", () => {
    expect(classify(110, undefined)).toBeNull();
  });

  // One sample is just "the previous turn", and comparing against a single
  // turn reports ordinary content variation as news.
  it("says nothing until the baseline has some history", () => {
    expect(classify(220, { rate: 110, samples: 1 })).toBeNull();
    expect(classify(220, { rate: 110, samples: 2 })).toBeNull();
    expect(classify(220, { rate: 110, samples: 3 })).toBe("fast");
  });

  it("calls a turn near the baseline normal", () => {
    expect(classify(110, settled)).toBe("normal");
    expect(classify(130, settled)).toBe("normal");
    expect(classify(90, settled)).toBe("normal");
  });

  // The band was set from measurement: five content types on one server
  // spanned 1.35x on their own, so anything tighter would fire on a change
  // of subject rather than a change in the server.
  it("stays quiet through content-driven variation", () => {
    expect(classify(119, { rate: 146, samples: 8 })).toBe("normal");
    expect(classify(161, { rate: 146, samples: 8 })).toBe("normal");
  });

  it("flags a turn well above the usual rate", () => {
    expect(classify(220, settled)).toBe("fast");
  });

  it("flags a turn well below it", () => {
    expect(classify(55, settled)).toBe("slow");
  });

  // Symmetric on a log scale, which is the scale a ratio lives on: half as
  // fast should read as far from normal as twice as fast.
  it("treats a halving and a doubling alike", () => {
    expect(classify(settled.rate * 2, settled)).toBe("fast");
    expect(classify(settled.rate / 2, settled)).toBe("slow");
  });
});
