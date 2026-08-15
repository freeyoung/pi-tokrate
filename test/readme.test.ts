import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_WORDS,
  DEFAULT_DISPLAY,
  ELEMENTS,
  elementLabel,
  parseCommand,
} from "../src/display.ts";
import { renderStatus, type Snapshot } from "../src/render.ts";

// Documentation drifts silently, and this one makes concrete claims: it
// prints example status lines, lists the menu verbatim, and shows the shape
// of what lands in settings.json. Every one of those was true when written
// and none of them is checked by anything else — a stored `display` string
// survived two rounds of it becoming an object.
//
// So the README is read back and compared against what the code does. Prose
// is left alone; only the parts that assert a fact are pinned.

const README = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
  "utf8",
);

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

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

describe("the README", () => {
  it("lists the menu exactly as the menu renders it", () => {
    for (const element of ELEMENTS) {
      const line = `[${DEFAULT_DISPLAY[element] ? "x" : " "}] ${elementLabel(element)}`;
      expect(README).toContain(line);
    }
  });

  it("mentions every word the command accepts", () => {
    for (const word of COMMAND_WORDS) {
      expect(README, `README never mentions "${word}"`).toContain(word);
    }
  });

  // Either a word the command takes, or a prefix the completion example is
  // part-way through typing. Anything else is a promise the command breaks.
  it("documents no word the command would reject", () => {
    const documented = [...README.matchAll(/\/tokrate ([a-z]+)/g)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(0);
    for (const word of documented) {
      const usable =
        parseCommand(word).kind !== "unknown" ||
        COMMAND_WORDS.some((candidate) => candidate.startsWith(word));
      expect(usable, `README shows "/tokrate ${word}"`).toBe(true);
    }
  });

  // The example lines at the top are the first thing anyone reads, and the
  // easiest thing to leave behind when a glyph or a separator changes.
  it.each([
    ["a turn with no thinking", "🌕 111 tok/s", { thinking: 0, answer: 1200 }],
    ["a turn thinking took over", "🌑 111 tok/s  90% think", { thinking: 9000, answer: 1000 }],
    ["a turn that answered nothing", "🌑 111 tok/s  33k think, no answer", { thinking: 32768, answer: 0 }],
  ])("shows what really renders for %s", (_label, line, over) => {
    expect(README).toContain(line);
    const rendered = renderStatus({ ...base, ...over }, DEFAULT_DISPLAY, theme);
    expect(normalise(rendered ?? "")).toBe(normalise(line));
  });

  it("shows the settings shape that is actually written", () => {
    for (const element of ELEMENTS) {
      expect(README, `settings example omits "${element}"`).toMatch(
        new RegExp(`"${element}":\\s*(true|false)`),
      );
    }
  });
});
