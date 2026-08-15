// ─── Display preferences ───────────────────────────────────────────
//
// The one kind of setting worth having.
//
// Everything else this extension could have exposed — how to count tokens,
// whether to trust streamed usage, where a colour threshold sits — has a
// correct answer that the code can measure and the user cannot reach
// without reading their server's source. Asking is a way of moving a
// problem rather than solving it.
//
// Which elements to show is the opposite. How much of a status bar to spend,
// and on what, is a preference with no correct answer, and nobody but the
// person reading it can settle it.
//
// The failure notices get a switch of their own, which they did not at
// first. The argument against was that they surface only when a turn
// produced no answer or is on course not to — the rarest thing shown here,
// and the reason the extension exists. But rarity is an assumption about
// the model, not a guarantee: one that habitually spends most of a turn
// deliberating trips the notice every time, and with the threshold
// deliberately not tunable there would be no way out of the noise. Default
// on, because it earns its place on the models it was built for.

// Ordered so the ones on out of the box come first, which makes the menu
// read as a block of ticks above a block of blanks.
//
// Deliberately a fixed order rather than one sorted by current state: a list
// that reordered itself would move an entry the moment you toggled it, and
// the cursor already returns to the top after every pick.
export const ELEMENTS = ["moon", "rate", "alert", "split", "tokens", "ttft"] as const;
export type Element = (typeof ELEMENTS)[number];

export type Display = Record<Element, boolean>;

/**
 * What each toggle controls, split so both surfaces can use it without
 * repeating themselves: the menu has no other name to show, while the
 * completion list already prints the element's own word in its label.
 */
export const ELEMENT_INFO: Record<Element, { title: string; blurb: string }> = {
  moon: { title: "Moon", blurb: "how much of the turn was thinking" },
  rate: { title: "Rate", blurb: "tokens per second" },
  alert: { title: "Alert", blurb: "warn when thinking crowds out the answer" },
  split: { title: "Split", blurb: "thinking and answer token counts" },
  tokens: { title: "Usage", blurb: "tokens generated and how long it took" },
  ttft: { title: "Latency", blurb: "time to the first token" },
};

/** The menu's wording for an element. */
export const elementLabel = (element: Element): string =>
  `${ELEMENT_INFO[element].title} — ${ELEMENT_INFO[element].blurb}`;

/**
 * The compact line: the shape of the turn and how fast it went.
 *
 * The rest is available and off, because a status bar is shared with
 * everything else Pi and other extensions want to say, and a default that
 * fills it is a default that gets uninstalled.
 */
export const DEFAULT_DISPLAY: Display = {
  moon: true,
  rate: true,
  alert: true,
  split: false,
  tokens: false,
  ttft: false,
};

/** Every element set the same way. */
export const uniform = (value: boolean): Display =>
  Object.fromEntries(ELEMENTS.map((element) => [element, value])) as Display;

export function isElement(value: unknown): value is Element {
  return typeof value === "string" && (ELEMENTS as readonly string[]).includes(value);
}

/**
 * Read a stored display preference, filling in anything absent.
 *
 * Also understands the two named modes this replaced, so an existing
 * settings file keeps working and keeps looking the way it did.
 */
export function toDisplay(raw: unknown): Display {
  if (raw === "full") return uniform(true);
  if (raw === "rate") return { ...DEFAULT_DISPLAY };
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_DISPLAY };

  const stored = raw as Record<string, unknown>;
  const display = { ...DEFAULT_DISPLAY };
  for (const element of ELEMENTS) {
    if (typeof stored[element] === "boolean") display[element] = stored[element];
  }
  return display;
}

/**
 * Named combinations, so the common cases are one word rather than a menu.
 *
 * Derived rather than written out, so that `none` is the same state as
 * clearing every box in the menu by construction and not by coincidence.
 * `default` is the one that stays hand-written: what a new element should
 * do out of the box is a judgement, not something to infer.
 */
export const PRESETS: Record<string, Display> = {
  all: uniform(true),
  none: uniform(false),
  default: { ...DEFAULT_DISPLAY },
};

export type Command =
  | { kind: "menu" }
  | { kind: "toggle"; element: Element }
  | { kind: "preset"; name: string; display: Display }
  | { kind: "unknown"; word: string };

/**
 * Read what `/tokrate <word>` asked for.
 *
 * Pi's select() cannot be reopened with the cursor where it was, so a menu
 * loop starts from the top after every toggle. Naming the element instead
 * skips the menu altogether, which is what anyone flipping the same switch
 * twice will want.
 */
export function parseCommand(args: string): Command {
  const word = args.trim().toLowerCase();
  if (!word) return { kind: "menu" };
  if (isElement(word)) return { kind: "toggle", element: word };
  const preset = PRESETS[word];
  if (preset) return { kind: "preset", name: word, display: { ...preset } };
  return { kind: "unknown", word };
}

/** Every word `/tokrate` accepts, for the error message and the docs. */
export const COMMAND_WORDS = [...ELEMENTS, ...Object.keys(PRESETS)];

/** One row of Pi's argument autocomplete. */
export interface Completion {
  value: string;
  label: string;
  description: string;
}

/** What each preset does, said the way the completion list says it. */
const PRESET_DESCRIPTIONS: Record<string, string> = {
  all: "Show everything",
  none: "Clear the status bar entirely",
  default: "Back to the compact line",
};

/**
 * Complete `/tokrate <prefix>`.
 *
 * The description carries each element's current state, so the list doubles
 * as a readout: seeing what is on is the question people open the menu to
 * answer, and this answers it without opening anything.
 */
export function completions(prefix: string, display: Display): Completion[] {
  const typed = prefix.trim().toLowerCase();
  const rows: Completion[] = [
    ...ELEMENTS.map((element) => ({
      value: element,
      label: element,
      description: `${display[element] ? "on" : "off"} — ${ELEMENT_INFO[element].blurb}`,
    })),
    ...Object.keys(PRESETS).map((name) => ({
      value: name,
      label: name,
      description: PRESET_DESCRIPTIONS[name] ?? "",
    })),
  ];
  return typed ? rows.filter((row) => row.value.startsWith(typed)) : rows;
}
