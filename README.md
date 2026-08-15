# pi-tokrate

Where a turn went, in Pi's status bar — how fast, how much of it was thinking, and whether that is normal for this model.

```
🌕 ~104 tok/s                        while the answer streams — inferred, so it says so
🌕 111 tok/s                         once the turn ends — measured, and normal for this model
🌓 111 tok/s                         half the turn went into thinking
🌑 111 tok/s  90% think              deliberation has taken the turn over
🌑 111 tok/s  33k think, no answer   the failure a speed readout cannot show you
```

The moon is the shape of the turn: **lit is the answer, dark is deliberation** — what you were given against what you paid for and never saw. A turn that answered in full is a full moon; one that thought itself into silence is a new moon. On a reasoning model it starts dark and fills as the answer arrives, and one that stays dark is the failure above, in progress.

Fullness rather than colour, because the rate beside it is already coloured — for speed against the model's baseline. Two colour scales on one line invite reading a red mark as "slow" when it means "mostly thinking".

Those particular characters are East Asian **Wide**, which is the property that matters. A ramp built from the obvious glyphs — `◌◔◑◕●` — is *Ambiguous* instead: Pi's width table counts one column, a terminal configured for CJK draws two, and the status line then runs past the width it was truncated to, wraps, and strands a row on every repaint. Wide characters carry no such disagreement. Nothing reaches the status bar without having been measured, and a test enforces it.

## Where this came from

[pi-token-speed](https://github.com/gsanhueza/pi-token-speed) by Gabriel Sanhueza is the extension that made this one possible: it is what taught me Pi's extension API, and its sliding-window design is the shape this one still follows. It is a good, working extension, and if you want a straightforward tokens-per-second readout it remains the simpler choice.

This one exists because of a specific failure. Chasing a discrepancy between a status bar and a server log, I found the status bar reading 41 tok/s while SGLang's own log read 111 — and the ratio between them was exactly the speculative-decoding accept length. What follows is what came out of taking that apart.

### How the two differ

|  | pi-token-speed | pi-tokrate |
|--|----------------|------------|
| **Counting** | one token per streamed chunk, or a word-boundary regex | text estimate, corrected per model against the provider's own count |
| **When the server batches tokens** | reads decode steps per second — 41 where the truth was 111 | unaffected; the batching is what the correction absorbs |
| **Colour** | fixed thresholds, 15 / 30 / 45 tok/s | deviation from that model's own learned baseline |
| **Estimated vs measured** | one number, presented the same either way | a live estimate wears `~`; the final measured number does not |
| **Reasoning models** | not distinguished | thinking and answer shown separately; a turn that returned no answer is called out |
| **Tool time** | subtracted for known prompt-processing tools | excluded at every generation-span boundary, whatever the tool |
| **Settings** | display mode, counting strategy, provider tokens, four colours, four thresholds | display mode |

Where pi-token-speed is the better pick: its count is exactly right on any server that emits one token per chunk, which is most of them, and it is right from the first turn with nothing to learn. It has more display modes, its colours and thresholds are yours to tune, and it never writes to `settings.json` mid-session. If none of the rows above describe a problem you have, it is the simpler thing and it works.

Where this one earns its keep: speculative decoding or `--stream-interval` on the serving side, a reasoning model that can talk itself out of answering, or wanting to know whether a turn was normal rather than merely how fast it was.

## Why a token count is harder than it looks

Nothing in an OpenAI-compatible stream says how many tokens a chunk carried. The count only arrives at the end of the turn, in the final usage payload. Every live number is therefore a proxy, and the obvious proxy — one token per streamed chunk — breaks the moment a server puts more than one token in a chunk. Two common settings do exactly that:

- **Speculative decoding.** Each decode step emits as many tokens as the draft model got right: 2 to 4 on a warm EAGLE setup.
- **`--stream-interval`** above 1, which batches deltas deliberately.

On a Qwen3.8 server with EAGLE, four consecutive log lines divided by their accept length all came to 41.3. The count was tracking *decode steps per second*, not tokens.

The failure mode is worse than an offset. The error equals the accept length, so it grows precisely when speculative decoding is working best — and a comparison of the feature against itself comes out backwards: 55 tok/s without it, 41 with, when the truth was 55 against 112.

## What this does instead

**Estimate from the text, then correct against ground truth.** Every turn ends with an authoritative token count. Divide it by what the estimator guessed and you have that model's correction factor, learned rather than configured. One number absorbs speculative batching, `--stream-interval`, an unfamiliar tokenizer, and a vocabulary that splits code differently — with no per-backend table to maintain or outgrow.

The factor is an exponential moving average, stored per `provider/model`, so it survives restarts. The first real sample is adopted outright rather than averaged against the placeholder, so a model is usually calibrated after one turn.

**A good base estimator still matters.** Calibration is a single scalar: it moves the centre of the error but cannot narrow its spread. An estimator that reads 96% on code and 176% on Chinese stays wrong through every change of subject, however well calibrated. So the weights were fitted against real output — ratios of estimate to the server's own count:

| content | one per chunk | `/\w+\|[^\s\w]/` | this |
|---------|--------------:|-----------------:|-----:|
| code | 31% | 96% | 97% |
| English prose | 42% | 99% | 103% |
| Chinese prose | 52% | 176% | 103% |
| mixed zh + code | – | – | 92% |
| JSON | – | – | 101% |
| markdown | – | – | 105% |

Mean 1.00, spread 0.14. The regex column's Chinese row is the one to notice: JavaScript's `\w` is ASCII-only, so every Han character falls through to the punctuation branch and scores a full token where the tokenizer packs nearly two into one. Cyrillic and Greek are handled by Unicode property for the same reason, though they remain the weakest cases at 82% and 56%.

**An estimate is labelled as an estimate.** A live rate is inferred, so it wears a `~`. When the turn ends and the provider's count lands, the tilde goes — regardless of how well calibrated the model is, because that final number divides an authoritative count by a measured duration and the estimator plays no part in it.

That distinction is not decoration. A precise-looking number that was 2.7× wrong is what invalidated the speculative-decoding comparison above; a tilde would have raised the question before the conclusion was drawn.

**Time excludes what wasn't generation.** Tool runs, permission prompts, and builds sit between deltas, and counting them would make tok/s a measure of how long you took to hit Enter. Pi announces where each span of generation begins and the clock never carries across that boundary, so a tool is excluded whether it took a minute or half a second. A 2-second idle threshold covers a stall inside a span that no event announces.

## Where the turn went

A throughput number cannot tell you the thing that actually goes wrong with a reasoning model. It can spend an entire budget deliberating and return nothing, and every rate reads healthy while it happens — the tokens are real, they are fast, and none of them is an answer. That is a session ending in `32768 reasoning tokens, 0 content`, and a speed readout will not mention it.

So the split is shown. `thinking_delta` and `text_delta` arrive separately in the stream; a tool call counts as output, since the model is acting on a conclusion rather than reaching one.

Where a provider breaks out reasoning tokens, that number is believed. Where it doesn't it reports zero whether or not the model thought, so a zero is no evidence and the streamed split stands in, scaled against the authoritative total. SGLang is the case in point: it does report reasoning tokens, just not at the path Pi reads, so its number arrives as `0` while thinking deltas were streaming the whole time.

The split is shown while the turn is still running, not only once it ends — a runaway is worth knowing about for exactly as long as it is still possible to do something about it.

What counts as worth interrupting for differs between the two. On a finished turn it is a share: past 75% of the total, deliberation was the story. On a running one a share is useless, because every reasoning turn is 100% thinking before it answers; what matters is how much of the model's output budget has already gone, since the answer has to come out of the rest. Past half, the compact display speaks up. Without a known budget it stays quiet rather than guess.

## Is this normal for this model?

The colour is a deviation from that model's own baseline, not a fixed threshold.

Absolute thresholds answer a question you can already answer — which model am I running. On modern serving hardware every local model sits permanently in the top band, so the colour says the same thing forever. The question worth answering is the one you can't: *is this turn slower than this model normally runs?* A server that picked up other traffic, a speculative-decoding setting that stopped paying off, a flag changed an hour ago — those show up as a deviation from history and nowhere else.

The band was set by measurement. Across five content types on one server, decode rate ran 118.9 to 160.7 tok/s — a spread of 1.35× from content alone, Chinese slowest because CJK gives a draft model less to predict. A band at 1.35 would light up every time the subject changed. At 1.5 it stays dark for that and still catches what matters.

Two rules keep it honest: the baseline moves slower than the signal it is a reference for, or it would sit on top of the current rate and every turn would read normal; and nothing is coloured until three turns of history exist, because a baseline of one sample is just "the previous turn".

## Settings

`/tokrate` names what to change, and completes as you type:

```
/tokrate t
   tokens    off — tokens generated and how long it took
   ttft      on  — time to the first token
```

Each completion carries that element's current state, so the list also answers *what is on right now* without opening anything. The words are the six elements plus three presets:

```
/tokrate ttft        toggle one element
/tokrate all         everything on
/tokrate default     back to the compact line
/tokrate none        clear the status entirely
/tokrate             open the menu
```

The menu lists the same five elements and loops, so two switches take two picks rather than two invocations:

```
tokrate — what the status bar shows
  [x] Moon — how much of the turn was thinking
  [x] Rate — tokens per second
  [x] Alert — warn when thinking crowds out the answer
  [ ] Split — thinking and answer token counts
  [ ] Usage — tokens generated and how long it took
  [ ] Latency — time to the first token
  ✓ Done
```

It does restart at the top after each pick. Pi's `select()` takes no starting position, so a reopened list has nowhere to put the cursor but the first row; short of writing a custom TUI component there is no fixing that from here. Naming the element on the command line avoids the menu entirely, which is the better answer for anything you flip more than once.

The first three are on out of the box, and the list is ordered that way so the menu reads as a block of ticks above a block of blanks. It is a fixed order rather than one sorted by current state: a list that reordered itself would move an entry the moment you toggled it. The default is kept short because a status bar is shared with everything else Pi and other extensions want to say, and a default that fills it is a default that gets uninstalled.

**Alert** is the failure notice — `no answer`, and the warning when thinking has eaten half the output budget. It is on by default and overrides **Split**, so the compact line still speaks up when a turn comes back empty. It very nearly had no switch at all, on the grounds that it fires rarely and only when something is wrong. But rarity is an assumption about the model: one that habitually spends most of a turn deliberating trips it every time, and with the threshold deliberately not tunable there would be no way out of the noise. Switching it off silences the alarm, not the accounting — with **Split** on, an empty turn is still reported, just without raising its voice.

Nothing overrides `none`. Switching every element off is an unambiguous request for an empty status bar, and honouring it everywhere except one case would be a promise the status bar breaks.

**How it measures** — whether to count chunks or characters, whether to trust streamed usage, where a colour threshold sits — is not offered at all. Those have correct answers that the code can determine by measuring, and that a user cannot reach without reading their server's source. Which parts to display has no correct answer and only you can settle it; how to count has one, and asking would just be moving the problem.

## Install

```
pi install npm:pi-tokrate
```

Hacking on it? Point Pi at your checkout:

```
ln -s "$PWD" ~/.pi/agent/extensions/pi-tokrate
```

Pi follows symlinks in its extension scan and reads `pi.extensions` from `package.json`, so edits land on restart with no copying. There are no runtime dependencies — every import from Pi is `import type`, erased at compile time.

It coexists with pi-token-speed; the two use different status keys and will both appear.

## Storage

Under the `tokrate` key in `~/.pi/agent/settings.json`:

```json
{
  "tokrate": {
    "display": "rate",
    "calibration": { "localllm-sglang/Qwen3.8-27B": { "ratio": 0.99, "samples": 9 } },
    "baseline":    { "localllm-sglang/Qwen3.8-27B": { "rate": 114.8, "samples": 9 } }
  }
}
```

Deleting an entry makes that model relearn from its next turn. A malformed one is dropped on read rather than reported — it costs a couple of turns to rebuild, and there is nothing a user could do about it that the code can't do itself. Writes merge per model, so two Pi sessions running side by side don't erase each other's learning.

## Licence

MIT. So is [pi-token-speed](https://github.com/gsanhueza/pi-token-speed), without which this would have started from a blank file.
