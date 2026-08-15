import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageStartEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

import { classify, observe, type Baseline, type Deviation } from "./src/baseline.ts";
import { correct, fold, modelKey, type Calibration } from "./src/calibrate.ts";
import { Meter } from "./src/meter.ts";
import { renderStatus, type Snapshot } from "./src/render.ts";
import {
  COMMAND_WORDS,
  completions,
  elementLabel,
  ELEMENTS,
  parseCommand,
  type Element,
} from "./src/display.ts";
import { read, write, type TokrateSettings } from "./src/store.ts";

const STATUS_KEY = "tokrate";

export default async (pi: ExtensionAPI) => {
  const meter = new Meter();
  let settings: TokrateSettings = read();
  // Captured when a turn starts: the calibration that turn is being scored
  // against, and the model it belongs to. Reading them again at the end
  // would attribute the turn to whatever model is current by then, which is
  // not necessarily the one that generated it.
  let turnKey = "";
  let turnCalibration: Calibration | undefined;
  let turnBaseline: Baseline | undefined;
  // Set once a turn has finished and been compared against its baseline.
  let turnDeviation: Deviation | null = null;
  let turnThinking: number | null = null;
  let turnAnswer: number | null = null;
  // The model's output ceiling, captured with the rest of the turn's
  // context so a mid-session model switch cannot judge one model's
  // thinking against another's budget.
  let turnBudget: number | null = null;

  const snapshot = (): Snapshot => {
    const streaming = meter.isStreaming;
    const raw = streaming ? meter.windowRate() : meter.turnRate();
    return {
      // Calibration corrects the estimate the live number is built from. It
      // has no part in the final number, which divides the provider's own
      // count by a measured duration.
      rate: raw === null ? null : streaming ? correct(raw, turnCalibration) : raw,
      measured: !streaming && meter.actualTokens !== null,
      // Corrected on the same terms as the rate beside it. Showing a
      // calibrated rate next to a raw count would put two numbers on one
      // line that disagree about how many tokens have been produced.
      tokens: meter.actualTokens ?? Math.round(correct(meter.estimatedTokens, turnCalibration)),
      seconds: meter.activeSeconds,
      ttft: meter.ttft,
      deviation: turnDeviation,
      // While the turn runs, the split comes from the same corrected
      // estimate as the rate above it. Waiting for the authoritative
      // numbers would hide a runaway for exactly as long as it is still
      // possible to do something about it.
      ...(turnThinking !== null
        ? { thinking: turnThinking, answer: turnAnswer }
        : liveSplit()),
      budget: turnBudget,
    };
  };

  /** The running thinking/answer split, corrected the same way the rate is. */
  const liveSplit = (): { thinking: number | null; answer: number | null } => {
    const total = correct(meter.estimatedTokens, turnCalibration);
    if (total <= 0) return { thinking: null, answer: null };
    const thinking = Math.round(total * meter.thinkingShare);
    return { thinking, answer: Math.max(0, Math.round(total) - thinking) };
  };

  // A delta can arrive dozens of times a second, and no terminal redraws
  // that fast. Repainting on every one costs render work nobody sees, so
  // live updates are thinned — but a final repaint always lands, since that
  // is the one carrying the authoritative number.
  const PAINT_INTERVAL_MS = 100;
  let lastPaintAt = 0;

  // Bound to the last context seen, so the settings menu — which is handed a
  // command context, not this one — can still redraw as toggles are flipped.
  let repaint: (() => void) | undefined;

  const paint = (ctx: ExtensionContext, force = false) => {
    repaint = () => ctx.ui.setStatus(STATUS_KEY, renderStatus(snapshot(), settings.display, ctx.ui.theme));
    const now = Date.now();
    if (!force && now - lastPaintAt < PAINT_INTERVAL_MS) return;
    lastPaintAt = now;
    repaint();
  };

  const setDisplay = (display: TokrateSettings["display"]) => {
    settings = { ...settings, display };
    write(settings);
    repaint?.();
  };

  const toggle = (element: Element) => {
    setDisplay({ ...settings.display, [element]: !settings.display[element] });
    return settings.display[element];
  };

  pi.registerCommand("tokrate", {
    description: `Choose what the token-rate status shows. With no argument, opens a menu; otherwise one of: ${COMMAND_WORDS.join(", ")}`,
    // Without this the argument form is undiscoverable — you have to already
    // know the words to type them. The descriptions carry each element's
    // current state, so the completion list also answers "what is on?".
    getArgumentCompletions: (prefix: string) => completions(prefix, settings.display),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = parseCommand(args);

      if (command.kind === "toggle") {
        const on = toggle(command.element);
        ctx.ui.notify(`tokrate: ${command.element} ${on ? "on" : "off"}`, "info");
        return;
      }
      if (command.kind === "preset") {
        setDisplay(command.display);
        ctx.ui.notify(`tokrate: ${command.name}`, "info");
        return;
      }
      if (command.kind === "unknown") {
        ctx.ui.notify(`tokrate: no such option "${command.word}". Try: ${COMMAND_WORDS.join(", ")}`, "warning");
        return;
      }

      // The menu is for finding out what exists. It loops, because flipping
      // two switches beats reopening it — but Pi's select() cannot be handed
      // a starting position, so the cursor returns to the top after each
      // pick. Naming the element on the command line avoids that entirely,
      // which is what the notification below points at.
      const DONE = "\u2713 Done";
      let toggled = false;
      while (true) {
        const options = ELEMENTS.map(
          (element) => `[${settings.display[element] ? "x" : " "}] ${elementLabel(element)}`,
        );
        const picked = await ctx.ui.select("tokrate — what the status bar shows", [...options, DONE]);
        if (!picked || picked === DONE) break;

        const index = options.indexOf(picked);
        if (index < 0) break;
        toggle(ELEMENTS[index]);
        toggled = true;
      }
      if (toggled) {
        ctx.ui.notify(`tokrate: /tokrate ${ELEMENTS.join("|")} toggles one directly`, "info");
      }
    },
  });

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    settings = read();
    ctx.ui.setStatus(STATUS_KEY, renderStatus({
      rate: null, measured: false, tokens: null, seconds: 0, ttft: null, deviation: null,
      thinking: null, answer: null, budget: null,
    }, settings.display, ctx.ui.theme));
  });

  pi.on("message_start", (event: MessageStartEvent, ctx: ExtensionContext) => {
    if (event.message.role !== "user") return;
    // A steering message sent mid-turn is still a user message. Resetting on
    // it would restart the estimate half way through while agent_end still
    // reports usage for the whole turn, and calibration would learn that
    // ratio as if it were real.
    if (meter.isStreaming) return;

    // The clock starts when the user sends, so time-to-first-token covers
    // the wait they actually experience.
    meter.reset();
    turnDeviation = null;
    turnThinking = null;
    turnAnswer = null;
    turnBudget = ctx.model?.maxTokens && ctx.model.maxTokens > 0 ? ctx.model.maxTokens : null;
    turnKey = modelKey(ctx.model?.provider, ctx.model?.id);
    turnCalibration = settings.calibration[turnKey];
    turnBaseline = settings.baseline[turnKey];
  });

  pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
    const ev = event.assistantMessageEvent;

    if (ev.type === "text_start" || ev.type === "thinking_start" || ev.type === "toolcall_start") {
      meter.markGenerationStart();
      return;
    }

    // Thinking counts. It is generated, it is billed, and on a reasoning
    // model it is most of what the server spends its time producing —
    // leaving it out would report a fraction of the real throughput.
    // A tool call counts as output, not deliberation: it is the model
    // acting on its conclusion rather than reaching one.
    if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
      meter.record(ev.delta ?? "", ev.type === "thinking_delta" ? "thinking" : "output");
      paint(ctx);
    }
  });

  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
    // Assistant messages only. Both halves of the calibration ratio have to
    // describe the same tokens, and the meter only ever saw what streamed
    // through this session — a tool that runs its own model reports usage on
    // a toolResult that never passed through here, and folding that in would
    // teach the ratio that our estimator undercounts when it did not.
    const actual = event.messages.reduce(
      (sum, m) => (m.role === "assistant" ? sum + m.usage.output : sum),
      0,
    );
    // A provider that breaks out reasoning tokens is believed; one that
    // doesn't reports 0 here whether or not the model thought, so a zero is
    // no evidence either way and the streamed split stands in. SGLang is
    // the case in point: it does report reasoning tokens, just not at the
    // path Pi reads, so its number arrives as 0 while thinking deltas were
    // streaming the whole time.
    const reportedThinking = event.messages.reduce(
      (sum, m) => (m.role === "assistant" ? sum + (m.usage.reasoning ?? 0) : sum),
      0,
    );
    const estimated = meter.estimatedTokens;
    meter.finish(actual);

    if (actual > 0) {
      // Clamped because the two numbers come from different places: a
      // reasoning count larger than the output it is a subset of would
      // otherwise render as a turn that answered with negative tokens.
      turnThinking = Math.min(
        actual,
        reportedThinking > 0 ? reportedThinking : Math.round(actual * meter.thinkingShare),
      );
      turnAnswer = actual - turnThinking;
    }

    // The whole design in one line: the turn just told us what it really
    // produced, so score our guess against it and keep the correction.
    //
    // Skipped when no turn was ever opened — a run that began without a user
    // message has no model attributed to it, and filing its ratio under a
    // blank key would pollute whichever model is loaded next.
    if (turnKey) {
      const rate = meter.turnRate();

      // Classified against the baseline as it stood before this turn. Fold
      // first and the turn would partly explain itself away, pulling the
      // reference towards whatever it was about to be compared with.
      if (rate !== null && meter.actualTokens !== null) {
        turnDeviation = classify(rate, turnBaseline);
      }

      const calibration = fold(turnCalibration, estimated, actual);
      const baseline =
        rate !== null && meter.actualTokens !== null
          ? observe(turnBaseline, rate, meter.activeSeconds)
          : turnBaseline;

      // fold hands back the very same object when a sample carries no
      // signal, and observe does the same, so identity catches both. The
      // samples check catches the other shape of "nothing learned": a first
      // turn that was rejected comes back as the placeholder, which is not
      // worth a file write or a stored entry claiming a model is calibrated.
      const learnedRatio = calibration !== turnCalibration && calibration.samples > 0;
      const learnedRate = baseline !== undefined && baseline !== turnBaseline;

      if (learnedRatio || learnedRate) {
        settings = {
          ...settings,
          calibration: learnedRatio
            ? { ...settings.calibration, [turnKey]: calibration }
            : settings.calibration,
          baseline: learnedRate
            ? { ...settings.baseline, [turnKey]: baseline }
            : settings.baseline,
        };
        write(settings);
        if (learnedRatio) turnCalibration = calibration;
        if (learnedRate) turnBaseline = baseline;
      }
    }

    paint(ctx, true);
  });
};
