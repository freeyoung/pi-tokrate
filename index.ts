import type {
  AgentEndEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

import { classify, observe, type Deviation } from "./src/baseline.ts";
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

/** One model's share of a turn: the two sides of its calibration ratio. */
interface Sample {
  estimated: number;
  actual: number;
}

/** A model's output ceiling, or null when it does not declare one. */
const budgetOf = (model: ExtensionContext["model"]): number | null =>
  model?.maxTokens && model.maxTokens > 0 ? model.maxTokens : null;

export default async (pi: ExtensionAPI) => {
  const meter = new Meter();
  let settings: TokrateSettings = read();
  // The calibration the live number is corrected by. It follows the model
  // that is answering right now, which is not always the one selected: a
  // virtual model routes each request to a physical one, and a correction
  // learned on one of them says nothing about another.
  let turnCalibration: Calibration | undefined;
  // Set once a turn has finished and been compared against its baseline.
  let turnDeviation: Deviation | null = null;
  let turnThinking: number | null = null;
  let turnAnswer: number | null = null;
  // The answering model's output ceiling, taken from the same place as its
  // calibration so that one model's thinking is never judged against
  // another's budget.
  let turnBudget: number | null = null;
  // What each physical model produced this turn: the estimator's total over
  // its responses and the provider's count for the same responses. Learning
  // is filed under the model named on the response, never under ctx.model,
  // which by the end of the turn may be another model or a virtual one.
  let served = new Map<string, Sample>();
  // Where the estimate stood when the current response began, so the share
  // of it that belongs to this response can be taken at its end.
  let responseStart = 0;

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

  pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
    // Every run opens a turn, not only the ones a user message starts. Pi
    // also starts a run to retry a failed request, to recover from a context
    // overflow, to deliver queued messages, and for an extension message
    // sent with triggerTurn. A meter carried over from the run before would
    // score each of those against tokens and time it never produced.
    //
    // A steering message, by contrast, joins the run already going and
    // opens nothing, so the estimate keeps covering what agent_end counts.
    //
    // agent_start lands just before the user's message is added, so
    // time-to-first-token still covers the wait they actually experience.
    meter.reset();
    served = new Map();
    responseStart = 0;
    turnDeviation = null;
    turnThinking = null;
    turnAnswer = null;
    // The selected model, until a response names the one actually answering.
    turnCalibration = settings.calibration[modelKey(ctx.model?.provider, ctx.model?.id)];
    turnBudget = budgetOf(ctx.model);
  });

  pi.on("message_start", (event: MessageStartEvent, ctx: ExtensionContext) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    // A response names the physical model that produced it. Under a virtual
    // model this is the first point at which that is known, and it can
    // change from one response to the next within a single turn.
    responseStart = meter.estimatedTokens;
    turnCalibration = settings.calibration[modelKey(message.provider, message.model)];
    const answering = ctx.modelRegistry.find(message.provider, message.model);
    if (answering) turnBudget = budgetOf(answering);
  });

  pi.on("message_end", (event: MessageEndEvent) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    // A response with no count from the provider has one side of the ratio
    // and not the other: an aborted request, or a server that sends no
    // usage. Folding in its estimate alone would teach the ratio that the
    // estimator overcounts when it did not.
    if (!(message.usage.output > 0)) return;

    const key = modelKey(message.provider, message.model);
    const sample = served.get(key) ?? { estimated: 0, actual: 0 };
    sample.estimated += meter.estimatedTokens - responseStart;
    sample.actual += message.usage.output;
    served.set(key, sample);
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

    // The whole design in one line: each response just told us what it
    // really produced, so score our guess against it and keep the correction.
    let calibration = settings.calibration;
    for (const [key, sample] of served) {
      const before = calibration[key];
      const after = fold(before, sample.estimated, sample.actual);
      // fold hands back the very same object when a sample carries no
      // signal, so identity catches that. The samples check catches the
      // other shape of "nothing learned": a first turn that was rejected
      // comes back as the placeholder, which is not worth a file write or a
      // stored entry claiming a model is calibrated.
      if (after !== before && after.samples > 0) calibration = { ...calibration, [key]: after };
    }

    // A speed only compares with one model's history. A turn that two
    // physical models shared has a rate that belongs to neither of them, so
    // it is neither coloured nor learned from.
    let baseline = settings.baseline;
    const rate = meter.turnRate();
    if (served.size === 1 && rate !== null && meter.actualTokens !== null) {
      const [key] = served.keys();
      const before = baseline[key];
      // Classified against the baseline as it stood before this turn. Fold
      // first and the turn would partly explain itself away, pulling the
      // reference towards whatever it was about to be compared with.
      turnDeviation = classify(rate, before);
      // observe, like fold, hands back what it was given when it learned
      // nothing.
      const after = observe(before, rate, meter.activeSeconds);
      if (after !== undefined && after !== before) baseline = { ...baseline, [key]: after };
    }

    if (calibration !== settings.calibration || baseline !== settings.baseline) {
      settings = { ...settings, calibration, baseline };
      write(settings);
    }

    paint(ctx, true);
  });
};
