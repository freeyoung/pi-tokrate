import { describe, expect, it } from "vitest";
import { correct, fold, modelKey, UNCALIBRATED } from "../src/calibrate.ts";

describe("fold", () => {
  // The placeholder ratio of 1 is not a measurement, so the first real
  // sample replaces it rather than being averaged against it.
  it("adopts the first sample outright", () => {
    expect(fold(undefined, 100, 270)).toEqual({ ratio: 2.7, samples: 1 });
  });

  it("smooths later samples instead of jumping to them", () => {
    const after = fold({ ratio: 2.7, samples: 1 }, 100, 300);
    expect(after.ratio).toBeCloseTo(2.7 * 0.7 + 3.0 * 0.3, 5);
    expect(after.samples).toBe(2);
  });

  // The common path: a model's very first turn already reflects how its
  // server batches, so the ratio is right from then on and stays there.
  it("is correct from the first turn on a steady server", () => {
    let c = fold(undefined, 100, 270);
    expect(c.ratio).toBeCloseTo(2.7, 5);
    for (let i = 0; i < 5; i++) c = fold(c, 100, 270);
    expect(c.ratio).toBeCloseTo(2.7, 5);
  });

  // The slow path, for a server whose behaviour changes under it — a
  // speculative-decoding setting flipped, say. Smoothing means this takes
  // several turns by design, so that one odd turn can't swing the display.
  it("tracks a mid-session step change over about ten turns", () => {
    let c = fold(undefined, 100, 100);
    expect(c.ratio).toBeCloseTo(1.0, 5);
    for (let i = 0; i < 10; i++) c = fold(c, 100, 270);
    expect(c.ratio).toBeCloseTo(2.7, 1);
  });

  // A short turn is mostly chat-template overhead the estimator never saw,
  // so its ratio says nothing about how the server batches tokens.
  it("ignores turns too short to carry signal", () => {
    const before = { ratio: 2.7, samples: 3 };
    expect(fold(before, 10, 500)).toBe(before);
  });

  it("ignores a turn the provider reported no output for", () => {
    const before = { ratio: 2.7, samples: 3 };
    expect(fold(before, 100, 0)).toBe(before);
  });

  // An aborted turn, or usage that belongs to a different request, lands
  // far from everything seen before and would otherwise poison the average.
  it("rejects a wild outlier once a ratio is established", () => {
    const before = { ratio: 2.7, samples: 5 };
    expect(fold(before, 100, 5000)).toBe(before);
  });

  it("still accepts a large but plausible shift in content mix", () => {
    const before = { ratio: 2.7, samples: 5 };
    const after = fold(before, 100, 500);
    expect(after.samples).toBe(6);
    expect(after.ratio).toBeGreaterThan(2.7);
  });

  it("ignores non-finite input rather than poisoning the ratio", () => {
    const before = { ratio: 2.7, samples: 3 };
    expect(fold(before, Number.NaN, 100)).toBe(before);
    expect(fold(before, 100, Number.POSITIVE_INFINITY)).toBe(before);
  });

  // Callers use reference identity to decide whether a turn taught them
  // anything worth writing to disk, so returning an equal-but-new object on
  // a rejected sample would turn every turn into a file write.
  it("returns the very same object when a sample is rejected", () => {
    const before = { ratio: 2.7, samples: 3 };
    expect(fold(before, 5, 500)).toBe(before);
    expect(fold(before, 100, 0)).toBe(before);
    expect(fold(before, 100, 99999)).toBe(before);
  });

  // The other half of that contract: with nothing to build on, a rejected
  // sample comes back as the placeholder, which callers can spot by its
  // sample count rather than mistaking it for a real calibration.
  it("returns an evidence-free placeholder when a first sample is rejected", () => {
    expect(fold(undefined, 5, 500)).toEqual(UNCALIBRATED);
    expect(fold(undefined, 5, 500).samples).toBe(0);
  });
});

describe("correct", () => {
  it("passes an estimate through untouched when uncalibrated", () => {
    expect(correct(120, undefined)).toBe(120);
    expect(correct(120, UNCALIBRATED)).toBe(120);
  });

  // The measured case: a Qwen3.8 server on EAGLE batched ~2.7 tokens per
  // chunk, so a one-per-chunk count of 41/s was really 111/s.
  it("recovers the true rate from a batched-chunk undercount", () => {
    expect(correct(41, { ratio: 2.7, samples: 4 })).toBeCloseTo(110.7, 1);
  });
});


describe("modelKey", () => {
  it("separates the same model id across providers", () => {
    expect(modelKey("localllm-sglang", "m")).not.toBe(modelKey("localllm-vllm", "m"));
  });

  it("survives a context with no model yet", () => {
    expect(modelKey(undefined, undefined)).toBe("unknown/unknown");
  });
});
