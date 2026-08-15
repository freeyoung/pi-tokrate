import { describe, expect, it } from "vitest";
import type { Display, Element } from "../src/display.ts";
import {
  COMMAND_WORDS,
  DEFAULT_DISPLAY,
  ELEMENTS,
  elementLabel,
  completions,
  parseCommand,
  toDisplay,
  uniform,
} from "../src/display.ts";

describe("toDisplay", () => {
  it("falls back to the defaults for anything it cannot read", () => {
    for (const junk of [undefined, null, 42, "neon", []]) {
      expect(toDisplay(junk)).toEqual(DEFAULT_DISPLAY);
    }
  });

  // The two named modes this replaced. An existing settings file has one of
  // these strings in it, and it should keep looking the way its owner left it.
  it("reads the modes it replaced", () => {
    expect(toDisplay("rate")).toEqual(DEFAULT_DISPLAY);
    expect(toDisplay("full")).toEqual(uniform(true));
  });

  it("keeps the elements a stored preference names", () => {
    expect(toDisplay({ moon: false, ttft: true })).toEqual({
      ...DEFAULT_DISPLAY,
      moon: false,
      ttft: true,
    });
  });

  // A preference written by a newer version, or hand-edited, should not be
  // able to leave an element undefined and crash the renderer.
  it("ignores entries that are not booleans", () => {
    expect(toDisplay({ moon: "yes", rate: 1, split: null })).toEqual(DEFAULT_DISPLAY);
  });

  it("ignores elements it does not know about", () => {
    expect(toDisplay({ moon: false, sparkline: true })).toEqual({
      ...DEFAULT_DISPLAY,
      moon: false,
    });
  });
});

describe("the element list", () => {
  it("labels every element the menu can offer", () => {
    for (const element of ELEMENTS) {
      expect(elementLabel(element)).toBeTruthy();
    }
  });

  // The default is the compact line, because a status bar is shared with
  // everything else Pi and other extensions want to say.
  it("starts with the shape of the turn, how fast it went, and the safety net", () => {
    expect(DEFAULT_DISPLAY).toEqual({
      moon: true,
      rate: true,
      alert: true,
      split: false,
      tokens: false,
      ttft: false,
    });
  });

  // The menu reads as a block of ticks above a block of blanks, which only
  // holds if the list is ordered that way to begin with.
  it("lists everything on by default before everything off", () => {
    const states = ELEMENTS.map((element) => DEFAULT_DISPLAY[element]);
    const firstOff = states.indexOf(false);
    expect(firstOff).toBeGreaterThan(0);
    expect(states.slice(firstOff).some(Boolean)).toBe(false);
  });
});

// Pi's select() cannot be reopened with the cursor where it was, so a menu
// loop restarts at the top after every pick. Naming the element skips the
// menu, which is the answer for anyone flipping the same switch twice.
describe("parseCommand", () => {
  it("opens the menu when given nothing", () => {
    expect(parseCommand("")).toEqual({ kind: "menu" });
    expect(parseCommand("   ")).toEqual({ kind: "menu" });
  });

  it("names an element to toggle", () => {
    expect(parseCommand("ttft")).toEqual({ kind: "toggle", element: "ttft" });
  });

  it("does not care about case or stray spaces", () => {
    expect(parseCommand("  TTFT ")).toEqual({ kind: "toggle", element: "ttft" });
  });

  it("recognises the presets", () => {
    const all = parseCommand("all");
    expect(all.kind).toBe("preset");
    expect(all.kind === "preset" && all.display.ttft).toBe(true);
    expect(parseCommand("default").kind === "preset" && parseCommand("default").kind).toBe("preset");
    const none = parseCommand("none");
    expect(none.kind === "preset" && Object.values(none.display).every((v) => !v)).toBe(true);
  });

  // A preset handed out by reference would let a later toggle rewrite the
  // preset itself, so the next `/tokrate all` would do something different.
  it("hands out a copy of a preset, not the preset", () => {
    const first = parseCommand("all");
    if (first.kind !== "preset") throw new Error("expected a preset");
    first.display.ttft = false;
    const second = parseCommand("all");
    expect(second.kind === "preset" && second.display.ttft).toBe(true);
  });

  it("reports a word it does not know rather than guessing", () => {
    expect(parseCommand("sparkline")).toEqual({ kind: "unknown", word: "sparkline" });
  });

  it("offers every word it accepts", () => {
    for (const word of COMMAND_WORDS) {
      expect(parseCommand(word).kind).not.toBe("unknown");
    }
  });
});

// Without completions the argument form is undiscoverable: you have to
// already know the words in order to type them.
describe("completions", () => {
  const display = { ...DEFAULT_DISPLAY };

  it("offers every word with no prefix typed", () => {
    expect(completions("", display).map((c) => c.value)).toEqual(COMMAND_WORDS);
  });

  it("narrows to what the prefix could become", () => {
    expect(completions("t", display).map((c) => c.value)).toEqual(["tokens", "ttft"]);
    expect(completions("mo", display).map((c) => c.value)).toEqual(["moon"]);
  });

  it("ignores case and stray spaces, as the command does", () => {
    expect(completions("  TT ", display).map((c) => c.value)).toEqual(["ttft"]);
  });

  it("returns nothing for a prefix that cannot match", () => {
    expect(completions("zz", display)).toEqual([]);
  });

  // Seeing what is currently on is the question people open the menu to
  // answer; carrying it here answers it without opening anything.
  it("says whether each element is on", () => {
    const rows = completions("", { ...DEFAULT_DISPLAY, moon: true, ttft: false });
    expect(rows.find((r) => r.value === "moon")?.description).toMatch(/^on —/);
    expect(rows.find((r) => r.value === "ttft")?.description).toMatch(/^off —/);
  });

  it("describes the presets too", () => {
    for (const name of ["all", "none", "default"]) {
      expect(completions(name, display)[0]?.description).toBeTruthy();
    }
  });

  it("completes to words the command actually accepts", () => {
    for (const row of completions("", display)) {
      expect(parseCommand(row.value).kind).not.toBe("unknown");
    }
  });
});

// Two ways to reach an empty status bar: name the preset, or clear every box
// in the menu. They have to land on the same state, or `/tokrate none` and
// an unchecked menu would disagree about whether the extension is showing
// anything — and the renderer only asks "is everything off?".
describe("none and an emptied menu", () => {
  /** What the menu does: flip one element at a time. */
  const toggle = (display: Display, element: Element): Display => ({
    ...display,
    [element]: !display[element],
  });

  it("reach the same state", () => {
    let byMenu: Display = { ...DEFAULT_DISPLAY };
    for (const element of ELEMENTS) {
      if (byMenu[element]) byMenu = toggle(byMenu, element);
    }
    const byPreset = parseCommand("none");
    if (byPreset.kind !== "preset") throw new Error("expected a preset");
    expect(byMenu).toEqual(byPreset.display);
  });

  // The mirror of it, so `all` cannot drift either.
  it("as do all and a fully checked menu", () => {
    let byMenu: Display = { ...DEFAULT_DISPLAY };
    for (const element of ELEMENTS) {
      if (!byMenu[element]) byMenu = toggle(byMenu, element);
    }
    const byPreset = parseCommand("all");
    if (byPreset.kind !== "preset") throw new Error("expected a preset");
    expect(byMenu).toEqual(byPreset.display);
  });

  // Derived from ELEMENTS rather than written out, so an element added later
  // cannot be left out of one and present in the other.
  it("cover every element the menu can show", () => {
    for (const name of ["all", "none"]) {
      const parsed = parseCommand(name);
      if (parsed.kind !== "preset") throw new Error("expected a preset");
      expect(Object.keys(parsed.display).sort()).toEqual([...ELEMENTS].sort());
    }
  });
});
