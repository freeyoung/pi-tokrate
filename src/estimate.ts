// ─── Live token estimation ─────────────────────────────────────────
//
// Nothing in an OpenAI-compatible stream tells you how many tokens a chunk
// contained. The obvious proxy — count one per chunk — is wrong by however
// many tokens the server packs into each one, and that number is neither
// constant nor knowable: speculative decoding makes it the accept length
// (2-4 on a warm EAGLE setup), and --stream-interval multiplies it again.
// Worse, the error tracks the thing you would most want to measure, since a
// server batches hardest exactly when it is generating fastest.
//
// So estimate from the text instead, then let calibration.ts correct the
// residual bias against the authoritative count that arrives at the end of
// every turn. The estimator's job is only to be proportional to the true
// count; being close as well just means calibration converges sooner and
// drifts less when the content mix changes mid-session.
//
// The weights below come from measuring a Qwen3.8 server, comparing this
// function against the server's own completion_tokens:
//
//   content        one-per-chunk    word-regex    this
//   code                     31%           96%     97%
//   English prose            42%           99%    103%
//   Chinese prose            52%          176%    103%
//   mixed zh + code            -             -     92%
//   JSON                       -             -    101%
//   markdown                   -             -    105%
//
// The word-regex column is what a naive /\w+|[^\s\w]/ gives, and its
// Chinese row is why this file exists: JavaScript's \w is ASCII-only, so
// every Han character falls through to the punctuation branch and scores 1,
// where a real tokenizer packs nearly two of them into one token.
//
// Spread matters more than centring. Calibration applies a single scalar per
// model, which moves the centre but cannot narrow the range — so an
// estimator that reads 96% on code and 176% on Chinese stays wrong through
// every shift in content mix, no matter how well calibrated. These weights
// hold within ±8% across all six samples, and that is the part calibration
// can't do for you.

// Han, Hiragana, Katakana, Hangul — scripts a BPE tokenizer packs several
// characters into one token.
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

// Fitted against Qwen's tokenizer; other families land close enough that
// calibration absorbs the difference within a turn or two.
const CJK_CHARS_PER_TOKEN = 1.8;

// Every other script's letters, identified by Unicode property rather than
// by ASCII range. Getting this wrong is exactly the flaw that makes the
// naive /\w+|[^\s\w]/ counter read Chinese at 176%: JavaScript's \w stops
// at ASCII, so everything past it scores a whole token per character. That
// is as wrong for Cyrillic or Greek as it is for Han, and there is no
// reason to fix one script family and leave the rest broken.
//
// Those two are the weakest cases even so, measured on the same server:
// Russian 82%, Greek 56%, because their words split into more subword
// tokens than a Latin word of the same length. No per-character bucket is
// fitted for them the way one is for CJK — the two samples disagree by 40%
// on characters per token, which is not a fit, and calibration absorbs a
// bias this consistent within a turn. The failure that mattered, scoring a
// whole token per character, is gone.
const LETTER_OR_DIGIT = /[\p{L}\p{N}_]/u;

// A newline usually merges with the indentation that follows it rather than
// standing alone, so it is worth well under a whole token.
const NEWLINE_TOKENS = 0.25;

// A run of word characters is usually one token, but long identifiers and
// long words get split. At or above this length, score by characters.
//
// The step at the threshold looks like something that wants smoothing, and
// it was tried: a plain max(1, length / 6) removes both the discontinuity
// and a constant, but widens the spread across the corpus from 0.14 to
// 0.19. Short words really are one token no matter how short, so the step
// is describing the tokenizer rather than approximating around it.
const LONG_WORD_CHARS = 10;
const CHARS_PER_TOKEN_IN_LONG_WORD = 6;

function scoreWord(length: number): number {
  if (length < LONG_WORD_CHARS) return 1;
  return length / CHARS_PER_TOKEN_IN_LONG_WORD;
}

/**
 * Approximate the number of tokens in a piece of streamed text.
 *
 * Fractional by design: these are summed across many deltas, and rounding
 * each one separately would bias the total upward on chunky streams.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let total = 0;
  let wordLength = 0;
  let cjkChars = 0;

  const flushWord = () => {
    if (wordLength > 0) {
      total += scoreWord(wordLength);
      wordLength = 0;
    }
  };

  for (const char of text) {
    // CJK first: those characters are letters too, but they are the ones a
    // tokenizer packs several of into one token, so they are counted apart.
    if (CJK.test(char)) {
      flushWord();
      cjkChars++;
      continue;
    }
    if (LETTER_OR_DIGIT.test(char)) {
      wordLength++;
      continue;
    }
    flushWord();

    // Spaces ride along with the token beside them rather than forming one.
    if (/\s/.test(char)) {
      if (char === "\n") total += NEWLINE_TOKENS;
      continue;
    }
    total += 1;
  }
  flushWord();

  return total + cjkChars / CJK_CHARS_PER_TOKEN;
}
