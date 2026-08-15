import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The wiring is the layer where the bugs have actually been: a timestamp of
// zero read as "unset", a reference comparison that persisted a placeholder,
// a split that existed but was never handed to the renderer. Every piece
// below it has unit tests; this drives the whole extension through the
// events Pi really sends and reads the status bar back out.

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  // Deltas in a real stream are milliseconds apart, and both the paint
  // throttle and the rate window are built around that. Firing a whole turn
  // inside one millisecond would measure nothing and repaint once.
  vi.useFakeTimers();
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tokrate-ext-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

type Handler = (event: any, ctx: any) => void;

/** Enough of Pi to run the extension against, plus a window on what it drew. */
async function boot(model = { provider: "local", id: "m", maxTokens: 65536 }) {
  const handlers = new Map<string, Handler>();
  const pi = {
    registerCommand: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  };
  const status: string[] = [];
  const ctx = {
    model,
    ui: {
      setStatus: (_key: string, text: string) => status.push(text),
      notify: () => {},
      theme: { fg: (style: string, text: string) => `<${style}>${text}</${style}>` },
    },
  };

  const extension = (await import("../index.ts")).default;
  await extension(pi as any);

  const fire = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload, ctx);
  /** One streamed delta, 20ms after the last — roughly what a live stream does. */
  const delta = (type: string, text: string) => {
    vi.advanceTimersByTime(20);
    fire("message_update", { assistantMessageEvent: { type, delta: text } });
  };

  return {
    fire,
    delta,
    startTurn: () => {
      fire("session_start");
      fire("message_start", { message: { role: "user" } });
      fire("message_update", { assistantMessageEvent: { type: "text_start" } });
    },
    endTurn: (output: number, reasoning?: number) =>
      fire("agent_end", { messages: [{ role: "assistant", usage: { output, reasoning } }] }),
    latest: () => status[status.length - 1] ?? "",
    /** What reached disk, or an empty shape when nothing was worth writing. */
    settings: () => {
      const file = path.join(home, ".pi", "agent", "settings.json");
      if (!fs.existsSync(file)) return { calibration: {}, baseline: {} };
      return JSON.parse(fs.readFileSync(file, "utf8")).tokrate ?? { calibration: {}, baseline: {} };
    },
  };
}

const WORDS = (n: number) => "alpha ".repeat(n);

describe("the extension end to end", () => {
  it("shows a placeholder before anything has streamed", async () => {
    const app = await boot();
    app.fire("session_start");
    expect(app.latest()).toContain("--");
  });

  it("marks the rate as an estimate while streaming and not after", async () => {
    const app = await boot();
    app.startTurn();
    for (let i = 0; i < 40; i++) app.delta("text_delta", WORDS(1));
    expect(app.latest()).toContain("~");

    app.endTurn(40);
    expect(app.latest()).not.toContain("~");
  });

  // The whole design: the turn reports what it really produced, and that
  // correction is kept for next time.
  it("learns a correction factor from a finished turn", async () => {
    const app = await boot();
    app.startTurn();
    for (let i = 0; i < 100; i++) app.delta("text_delta", WORDS(1));
    app.endTurn(270); // the server produced 2.7x what the estimator saw

    const stored = app.settings().calibration["local/m"];
    expect(stored.ratio).toBeCloseTo(2.7, 1);
    expect(stored.samples).toBe(1);
  });

  it("does not record anything from a turn too short to mean anything", async () => {
    const app = await boot();
    app.startTurn();
    app.delta("text_delta", WORDS(3));
    app.endTurn(9);
    expect(app.settings().calibration["local/m"]).toBeUndefined();
  });

  // The failure this extension exists to make visible, seen while it is
  // still happening rather than announced after the fact.
  it("warns mid-turn once thinking has eaten half the output budget", async () => {
    const app = await boot({ provider: "local", id: "m", maxTokens: 8192 });
    app.startTurn();
    // Past 4096, half of this model's ceiling, with no answer started.
    for (let i = 0; i < 50; i++) app.delta("thinking_delta", WORDS(100));
    expect(app.latest()).toContain("<warning>");
    expect(app.latest()).toContain("think");
  });

  it("stays quiet mid-turn while thinking is still a small part of the budget", async () => {
    const app = await boot();
    app.startTurn();
    for (let i = 0; i < 10; i++) app.delta("thinking_delta", WORDS(10));
    expect(app.latest()).not.toContain("<warning>");
  });

  it("reports a turn that deliberated and never answered", async () => {
    const app = await boot();
    app.startTurn();
    for (let i = 0; i < 100; i++) app.delta("thinking_delta", WORDS(100));
    app.endTurn(32768);

    expect(app.latest()).toContain("<error>");
    expect(app.latest()).toContain("no answer");
  });

  // A provider that breaks out reasoning tokens is believed over the split
  // the estimator inferred from the stream.
  it("prefers the provider's own reasoning count", async () => {
    const app = await boot();
    app.fire("session_start");
    app.fire("message_start", { message: { role: "user" } });
    app.fire("message_update", { assistantMessageEvent: { type: "text_start" } });
    for (let i = 0; i < 50; i++) app.delta("text_delta", WORDS(1));
    for (let i = 0; i < 50; i++) app.delta("thinking_delta", WORDS(1));
    app.endTurn(1000, 900); // provider: 900 of the 1000 were reasoning

    // 90% thinking is past the share that gets said out loud.
    expect(app.latest()).toContain("90% think");
  });

  it("attributes a turn to the model that generated it, not the one loaded later", async () => {
    const app = await boot();
    app.startTurn();
    for (let i = 0; i < 100; i++) app.delta("text_delta", WORDS(1));
    app.endTurn(270);
    expect(Object.keys(app.settings().calibration)).toEqual(["local/m"]);
  });

  // A steering message arrives mid-turn as another user message; resetting
  // on it would leave the estimate covering less than the usage does.
  it("ignores a steering message sent mid-turn", async () => {
    const app = await boot();
    app.startTurn();
    for (let i = 0; i < 50; i++) app.delta("text_delta", WORDS(1));
    app.fire("message_start", { message: { role: "user" } });
    for (let i = 0; i < 50; i++) app.delta("text_delta", WORDS(1));
    app.endTurn(270);

    // Had the reset landed, only half the turn would have been estimated
    // and the ratio would have come out at twice this.
    expect(app.settings().calibration["local/m"].ratio).toBeCloseTo(2.7, 1);
  });

  it("colours nothing until a baseline has enough history", async () => {
    const app = await boot();
    for (let turn = 0; turn < 2; turn++) {
      app.startTurn();
      for (let i = 0; i < 100; i++) app.delta("text_delta", WORDS(1));
      app.endTurn(100);
    }
    expect(app.latest()).not.toContain("<success>");
    expect(app.latest()).not.toContain("<warning>");
  });
});
