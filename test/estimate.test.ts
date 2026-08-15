import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/estimate.ts";
import corpus from "./qwen38-corpus.json" with { type: "json" };

describe("estimateTokens", () => {
  it("counts nothing in an empty delta", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("scores a short word as one token", () => {
    expect(estimateTokens("hello")).toBe(1);
  });

  // A tokenizer splits long identifiers; scoring them as one would
  // undercount code badly, where they are everywhere.
  it("splits a long identifier by length", () => {
    expect(estimateTokens("getUserPreferences")).toBeGreaterThan(2);
  });

  it("counts punctuation separately from the words around it", () => {
    expect(estimateTokens("a, b")).toBe(3);
  });

  // The bug this file exists to fix: JavaScript's \w is ASCII-only, so a
  // regex-based counter scores one token per Han character where the
  // tokenizer packs nearly two of them into one.
  it("packs CJK characters rather than counting one each", () => {
    const text = "哈希表是一种数据结构";
    expect(estimateTokens(text)).toBeLessThan(text.length * 0.7);
    expect(estimateTokens(text)).toBeGreaterThan(text.length * 0.4);
  });

  // The same trap as the Chinese case, one script family over: an ASCII-only
  // notion of "word character" sends Cyrillic and Greek down the punctuation
  // branch at a full token each. Measured against the real tokenizer these
  // still read low (Russian 82%, Greek 56%), but the pathological direction
  // is what this guards.
  it("treats non-Latin alphabets as words, not as punctuation", () => {
    const russian = "Привет как дела";
    expect(estimateTokens(russian)).toBeLessThan(russian.length * 0.5);
    const greek = "Καλημέρα κόσμε";
    expect(estimateTokens(greek)).toBeLessThan(greek.length * 0.5);
  });

  it("does not let spaces inflate the count", () => {
    expect(estimateTokens("a b c")).toBe(estimateTokens("a  b  c"));
  });

  // Whitespace-only deltas do arrive mid-stream; they must not read as
  // generation progress or an idle stream looks fast.
  it("scores a run of spaces as nothing", () => {
    expect(estimateTokens("    ")).toBe(0);
  });

  it("is additive across deltas, since that is how it is summed", () => {
    const whole = "function shuffle(array) {";
    const split = ["function shu", "ffle(array", ") {"];
    const summed = split.reduce((acc, part) => acc + estimateTokens(part), 0);
    // Splitting a word across deltas costs a little accuracy; the bound is
    // what keeps that from mattering over a whole turn.
    expect(Math.abs(summed - estimateTokens(whole))).toBeLessThan(2);
  });

  // Guards the fitted weights against real output. The fixture holds six
  // responses from a Qwen3.8 server alongside the token counts that server
  // reported for them, so these run the estimator against ground truth
  // rather than against another constant.
  describe("against real Qwen3.8 output", () => {
    it.each(corpus.map((c) => [c.label, c] as const))("stays within 10%% on %s", (_label, sample) => {
      const ratio = estimateTokens(sample.text) / sample.actualTokens;
      expect(Math.abs(ratio - 1)).toBeLessThan(0.1);
    });

    // The property calibration cannot supply. A single scalar per model can
    // move the centre of these ratios but never narrow their range, so an
    // estimator whose error swings with the content mix stays wrong however
    // well it is calibrated.
    it("holds its spread across every content type", () => {
      const ratios = corpus.map((c) => estimateTokens(c.text) / c.actualTokens);
      expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.2);
    });

    it("is centred, so an uncalibrated first turn is already close", () => {
      const ratios = corpus.map((c) => estimateTokens(c.text) / c.actualTokens);
      const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      expect(mean).toBeCloseTo(1, 1);
    });
  });
});
