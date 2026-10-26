import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// store.ts resolves the settings path once, at import time, from the home
// directory — so the home directory is what has to move. os.homedir() reads
// $HOME on POSIX, which makes this a matter of an environment variable and
// a fresh import rather than of mocking a built-in module.
let home: string;
let settingsPath: string;
let originalHome: string | undefined;
let originalAgentDir: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  // Pi's own override wins over the home directory. Left set from the shell
  // running the tests, it would point every write here at the real thing.
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tokrate-"));
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  settingsPath = path.join(home, ".pi", "agent", "settings.json");
  process.env.HOME = home;
  vi.resetModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const load = async () => await import("../src/store.ts");
const DEFAULTS = { moon: true, rate: true, split: false, alert: true, tokens: false, ttft: false };
const onDisk = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const seed = (contents: unknown) => fs.writeFileSync(settingsPath, JSON.stringify(contents), "utf8");

describe("read", () => {
  it("returns defaults when the file does not exist", async () => {
    const { read } = await load();
    expect(read()).toEqual({ display: DEFAULTS, calibration: {}, baseline: {} });
  });

  it("returns defaults when the file is not valid JSON", async () => {
    fs.writeFileSync(settingsPath, "{ not json", "utf8");
    const { read } = await load();
    expect(read()).toEqual({ display: DEFAULTS, calibration: {}, baseline: {} });
  });

  // A corrupt entry costs a couple of turns to relearn, which is cheaper
  // than propagating a ratio of NaN into every rate shown.
  it("drops entries that are not usable calibrations", async () => {
    seed({
      tokrate: {
        display: "full",
        calibration: {
          good: { ratio: 2.7, samples: 3 },
          negative: { ratio: -1, samples: 3 },
          missing: { samples: 3 },
          notObject: "2.7",
        },
      },
    });
    const { read } = await load();
    expect(read().calibration).toEqual({ good: { ratio: 2.7, samples: 3 } });
  });

  // The two named modes this replaced still parse, so an existing settings
  // file keeps looking the way its owner left it.
  it("understands the display modes it used to have", async () => {
    seed({ tokrate: { display: "full", calibration: {} } });
    expect((await load()).read().display).toEqual({
      moon: true, rate: true, split: true, alert: true, tokens: true, ttft: true,
    });

    vi.resetModules();
    seed({ tokrate: { display: "rate", calibration: {} } });
    expect((await load()).read().display).toEqual(DEFAULTS);
  });

  it("fills in elements a stored preference does not mention", async () => {
    seed({ tokrate: { display: { ttft: true, moon: false }, calibration: {} } });
    expect((await load()).read().display).toEqual({ ...DEFAULTS, ttft: true, moon: false });
  });

  it("falls back to defaults for a preference it cannot read", async () => {
    seed({ tokrate: { display: "neon", calibration: {} } });
    expect((await load()).read().display).toEqual(DEFAULTS);
  });
});

describe("write", () => {
  it("leaves other extensions' settings untouched", async () => {
    seed({ localllm: { servers: [] }, tokrate: { display: "rate", calibration: {} } });
    const { write } = await load();
    write({ display: DEFAULTS, calibration: {}, baseline: {} });
    expect(onDisk().localllm).toEqual({ servers: [] });
    expect(onDisk().tokrate.display).toEqual(DEFAULTS);
  });

  // Two Pi sessions each hold their own copy of the map. Writing ours
  // wholesale would erase what the other learned about a model this session
  // never touched.
  it("preserves calibrations this session knows nothing about", async () => {
    seed({
      tokrate: {
        display: "rate",
        calibration: { "other/model": { ratio: 3.1, samples: 8 } },
      },
    });
    const { write } = await load();
    write({ display: DEFAULTS, calibration: { "mine/model": { ratio: 1.2, samples: 2 } }, baseline: {} });

    expect(onDisk().tokrate.calibration).toEqual({
      "other/model": { ratio: 3.1, samples: 8 },
      "mine/model": { ratio: 1.2, samples: 2 },
    });
  });

  it("wins for a model both sessions have touched", async () => {
    seed({ tokrate: { display: "rate", calibration: { m: { ratio: 3.1, samples: 8 } } } });
    const { write } = await load();
    write({ display: DEFAULTS, calibration: { m: { ratio: 1.2, samples: 2 } }, baseline: {} });
    expect(onDisk().tokrate.calibration.m).toEqual({ ratio: 1.2, samples: 2 });
  });

  it("does not carry a corrupt on-disk entry back into the file", async () => {
    seed({ tokrate: { display: "rate", calibration: { bad: { ratio: 0, samples: 1 } } } });
    const { write } = await load();
    write({ display: DEFAULTS, calibration: { good: { ratio: 1.2, samples: 2 } }, baseline: {} });
    expect(onDisk().tokrate.calibration).toEqual({ good: { ratio: 1.2, samples: 2 } });
  });

  it("creates the block when the file has no settings for it yet", async () => {
    seed({ somethingElse: true });
    const { write } = await load();
    write({ display: DEFAULTS, calibration: { m: { ratio: 1.5, samples: 1 } }, baseline: {} });
    expect(onDisk().tokrate.calibration.m).toEqual({ ratio: 1.5, samples: 1 });
    expect(onDisk().somethingElse).toBe(true);
  });
});

describe("location", () => {
  // Pi keeps its settings wherever PI_CODING_AGENT_DIR says. Writing to the
  // default path regardless would put this key in a file Pi never reads.
  it("follows Pi's config directory when it has been moved", async () => {
    const moved = path.join(home, "elsewhere");
    fs.mkdirSync(moved);
    process.env.PI_CODING_AGENT_DIR = moved;
    const { write } = await load();
    write({ display: DEFAULTS, calibration: { "a/b": { ratio: 1.2, samples: 3 } }, baseline: {} });

    const written = JSON.parse(fs.readFileSync(path.join(moved, "settings.json"), "utf8"));
    expect(written.tokrate.calibration["a/b"].ratio).toBe(1.2);
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it("expands a leading tilde the way Pi does", async () => {
    fs.mkdirSync(path.join(home, "pi-config"));
    process.env.PI_CODING_AGENT_DIR = "~/pi-config";
    const { write } = await load();
    write({ display: DEFAULTS, calibration: {}, baseline: {} });

    expect(fs.existsSync(path.join(home, "pi-config", "settings.json"))).toBe(true);
  });
});
