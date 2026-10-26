// ─── Persistence ───────────────────────────────────────────────────
//
// Calibration is worth keeping between sessions: it is the one piece of
// state that takes real turns to earn, and throwing it away every restart
// would put a tilde back on the status bar every morning.
//
// It lives in Pi's own settings.json under a single key, alongside every
// other extension's config, so there is no extra file to find or clean up.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Baseline } from "./baseline.ts";
import type { Calibration } from "./calibrate.ts";
import { DEFAULT_DISPLAY, toDisplay, type Display } from "./display.ts";

export interface TokrateSettings {
  /** Which elements the status bar shows. The one preference a user can answer. */
  display: Display;
  /** Learned correction factors, keyed by provider/model. */
  calibration: Record<string, Calibration>;
  /**
   * Learned normal speeds, on the same keys.
   *
   * A separate map rather than more fields on a calibration entry: the two
   * are learned from different evidence and under different conditions, and
   * a file written before baselines existed stays readable as it is.
   */
  baseline: Record<string, Baseline>;
}

/**
 * Pi's config directory, resolved the way Pi resolves it.
 *
 * PI_CODING_AGENT_DIR moves every file Pi owns. Ignoring it would leave this
 * key in a settings.json that Pi no longer reads, in a directory the user
 * believes they moved away from.
 *
 * Copied rather than imported: Pi's own getAgentDir() would be the only
 * runtime import from Pi, where every other one is a type.
 */
function agentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(os.homedir(), ".pi", "agent");
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

const SETTINGS_FILE = path.join(agentDir(), "settings.json");
const SETTINGS_KEY = "tokrate";

const empty = (): TokrateSettings => ({
  display: { ...DEFAULT_DISPLAY },
  calibration: {},
  baseline: {},
});

/** A learned value is only usable if it is positive and finite. */
function isLearned(value: unknown, field: "ratio" | "rate"): boolean {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const measurement = c[field];
  return (
    typeof measurement === "number" &&
    Number.isFinite(measurement) &&
    measurement > 0 &&
    typeof c.samples === "number" &&
    Number.isFinite(c.samples) &&
    c.samples >= 0
  );
}

const isCalibration = (v: unknown): v is Calibration => isLearned(v, "ratio");
const isBaseline = (v: unknown): v is Baseline => isLearned(v, "rate");

/** Copy across only the entries that survive their guard. */
function clean<T>(raw: unknown, guard: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (guard(value)) out[key] = value;
  }
  return out;
}

/**
 * Read this extension's settings, discarding anything malformed.
 *
 * A corrupt entry costs at most a few turns of re-learning, so it is
 * dropped silently rather than surfaced — there is nothing a user could
 * usefully do about it, and a warning on every session start would be worse
 * than the problem.
 */
export function read(): TokrateSettings {
  try {
    const all = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
    const raw = all[SETTINGS_KEY] as Partial<TokrateSettings> | undefined;
    if (!raw) return empty();

    return {
      display: toDisplay(raw.display),
      calibration: clean(raw.calibration, isCalibration),
      baseline: clean(raw.baseline, isBaseline),
    };
  } catch {
    return empty();
  }
}

/**
 * Merge this extension's settings back into settings.json.
 *
 * Read-modify-write, because the file belongs to Pi and every other
 * extension in it.
 *
 * The merge goes one level deeper than that, into the calibration map,
 * because two Pi sessions running side by side each hold their own copy.
 * Writing ours wholesale would erase whatever the other one learned about a
 * model this session never touched — silently, and for as long as it takes
 * that session to relearn. Per-model entries we hold win; everything else
 * on disk is left alone.
 *
 * Failures are swallowed: losing one calibration update is not worth
 * interrupting a session over, and the next turn writes again.
 */
export function write(settings: TokrateSettings): void {
  try {
    let all: Record<string, unknown> = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      all = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
    }
    const onDisk = all[SETTINGS_KEY] as Partial<TokrateSettings> | undefined;

    all[SETTINGS_KEY] = {
      display: settings.display,
      calibration: { ...clean(onDisk?.calibration, isCalibration), ...settings.calibration },
      baseline: { ...clean(onDisk?.baseline, isBaseline), ...settings.baseline },
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2), "utf8");
  } catch {
    // Ignore — the in-memory calibration still holds for this session.
  }
}
