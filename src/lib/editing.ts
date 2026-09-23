export interface Range {
  start: number;
  end: number;
}
export interface Word extends Range {
  text: string;
}
/** score is semantic relevance in [0, 1], NOT a prediction of virality. */
export interface Clip extends Range {
  id: string;
  title: string;
  score: number;
  text: string;
}
export interface Filler extends Range {
  confidence: number;
}
export type Candidate = Range & { text: string };

const finiteRange = (range: Range): boolean =>
  !!range &&
  Number.isFinite(range.start) &&
  Number.isFinite(range.end) &&
  range.end > range.start;

/** Discard malformed/empty ranges, clamp to [0,duration], sort and merge touching ranges. */
export function mergeRanges(ranges: Range[], duration: number): Range[] {
  if (!Number.isFinite(duration) || duration < 0)
    throw new RangeError("Duration must be finite and nonnegative.");
  const sorted = ranges
    .filter(finiteRange)
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(duration, start)),
      end: Math.max(0, Math.min(duration, end)),
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Range[] = [];
  for (const range of sorted) {
    const last = result[result.length - 1];
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

/** Half-open source intervals. Invalid selection gives []; cuts outside it have no effect. */
export function subtractRanges(selection: Range, cuts: Range[]): Range[] {
  if (!finiteRange(selection) || selection.end <= 0) return [];
  const start = Math.max(0, selection.start);
  const result: Range[] = [];
  let cursor = start;
  for (const cut of mergeRanges(cuts, selection.end)) {
    if (cut.end <= cursor || cut.start >= selection.end) continue;
    if (cut.start > cursor) result.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < selection.end)
    result.push({ start: cursor, end: selection.end });
  return result;
}

function cleanWords(words: Word[]): Word[] {
  return words
    .filter(
      (word) =>
        finiteRange(word) &&
        word.end > 0 &&
        typeof word.text === "string" &&
        word.text.trim(),
    )
    .map((word) => ({
      start: Math.max(0, word.start),
      end: word.end,
      text: word.text.trim(),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
const sentenceEnd = (text: string): boolean =>
  /[.!?…][\s"'”’\])}]*$/.test(text);
function joinText(parts: string[]): string {
  return parts.join(" ").replace(/\s+([,.;:!?…])/g, "$1");
}
function stamp(ms: number): string {
  const h = Math.floor(ms / 3600000),
    m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
function captionLines(text: string): string {
  if (text.length <= 42) return text;
  const spaces = [...text.matchAll(/ /g)].map((match) => match.index!);
  if (!spaces.length) return text;
  const split = spaces.reduce((best, index) =>
    Math.abs(index - text.length / 2) < Math.abs(best - text.length / 2)
      ? index
      : best,
  );
  return `${text.slice(0, split)}\n${text.slice(split + 1)}`;
}

/** Retimes actual word intervals into concatenated keep ranges; does not invent word timestamps. */
export function toSrt(words: Word[], keep: Range[]): string {
  const duration = keep
    .filter(finiteRange)
    .reduce((maximum, range) => Math.max(maximum, range.end), 0);
  const kept = mergeRanges(keep, duration);
  if (!kept.length) return "";
  let offset = 0;
  const segments = kept.map((range) => {
    const segment = { ...range, offset };
    offset += range.end - range.start;
    return segment;
  });
  const timed: Word[] = [];
  for (const word of cleanWords(words)) {
    let start = Infinity,
      end = -Infinity;
    for (const segment of segments) {
      const a = Math.max(word.start, segment.start),
        b = Math.min(word.end, segment.end);
      if (b > a) {
        start = Math.min(start, segment.offset + a - segment.start);
        end = Math.max(end, segment.offset + b - segment.start);
      }
    }
    // A word straddling a cut is included once, with its retained time span.
    if (end > start) timed.push({ text: word.text, start, end });
  }
  timed.sort((a, b) => a.start - b.start || a.end - b.end);
  const captions: Word[] = [];
  let current: Word | undefined;
  for (const word of timed) {
    if (
      current &&
      (word.start - current.end > 0.8 ||
        word.end - current.start > 6 ||
        joinText([current.text, word.text]).length > 72 ||
        sentenceEnd(current.text))
    ) {
      captions.push(current);
      current = undefined;
    }
    if (!current) current = { ...word };
    else {
      current.text = joinText([current.text, word.text]);
      current.end = Math.max(current.end, word.end);
    }
  }
  if (current) captions.push(current);
  let previousEnd = 0;
  const cues: string[] = [];
  const totalMs = Math.round(offset * 1000);
  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    const start = Math.max(previousEnd, Math.round(caption.start * 1000));
    const nextStart =
      i + 1 < captions.length
        ? Math.round(captions[i + 1].start * 1000)
        : totalMs;
    const end = Math.min(
      totalMs,
      Math.max(start + 1, Math.min(Math.round(caption.end * 1000), nextStart)),
    );
    if (end <= start) continue;
    cues.push(
      `${cues.length + 1}\n${stamp(start)} --> ${stamp(end)}\n${captionLines(caption.text)}`,
    );
    previousEnd = end;
  }
  return cues.length ? `${cues.join("\n\n")}\n` : "";
}

/** Sentence-boundary windows nearest target duration. A single long sentence remains intact. */
export function makeCandidates(
  words: Word[],
  targetSeconds: number,
): Candidate[] {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0)
    throw new RangeError("Target seconds must be finite and positive.");
  const sentences: Candidate[] = [];
  let current: Candidate | undefined;
  for (const word of cleanWords(words)) {
    if (!current) current = { ...word };
    else {
      current.text = joinText([current.text, word.text]);
      current.end = Math.max(current.end, word.end);
    }
    if (sentenceEnd(word.text)) {
      sentences.push(current);
      current = undefined;
    }
  }
  if (current) sentences.push(current);
  return sentences.map((sentence, i) => {
    let end = sentence.end;
    const texts = [sentence.text];
    for (let j = i + 1; j < sentences.length; j++) {
      const nextEnd = Math.max(end, sentences[j].end);
      if (
        Math.abs(nextEnd - sentence.start - targetSeconds) >=
        Math.abs(end - sentence.start - targetSeconds)
      )
        break;
      end = nextEnd;
      texts.push(sentences[j].text);
    }
    return { start: sentence.start, end, text: joinText(texts) };
  });
}

function normalize(vector: number[]): number[] {
  if (
    !Array.isArray(vector) ||
    !vector.length ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new TypeError(
      "Every candidate requires a finite, nonempty embedding.",
    );
  }
  // Scale before squaring so finite very large/small vectors remain usable.
  const scale = vector.reduce(
    (max, value) => Math.max(max, Math.abs(value)),
    0,
  );
  if (!scale) throw new RangeError("Zero embeddings are not meaningful.");
  const scaled = vector.map((value) => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return scaled.map((value) => value / norm);
}
const dot = (a: number[], b: number[]): number =>
  Math.max(
    -1,
    Math.min(
      1,
      a.reduce((sum, value, i) => sum + value * b[i], 0),
    ),
  );

/** Local embedding-based relevance, transcript salience, and MMR diversity; no network or viral claims. */
export function rankCandidates(
  candidates: Candidate[],
  vectors: number[][],
  limit = 5,
): Clip[] {
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit))
    throw new RangeError("Limit must be a nonnegative integer.");
  if (vectors.length !== candidates.length)
    throw new RangeError("Provide exactly one embedding per candidate.");
  if (!candidates.length) return [];
  if (
    candidates.some(
      (c) =>
        !finiteRange(c) ||
        c.start < 0 ||
        typeof c.text !== "string" ||
        !c.text.trim(),
    )
  ) {
    throw new TypeError(
      "Candidates must have finite positive intervals and nonempty text.",
    );
  }
  const unit = vectors.map(normalize);
  if (unit.some((vector) => vector.length !== unit[0].length))
    throw new RangeError("Embedding dimensions must match.");
  const centroid = unit[0].map((_, dimension) =>
    unit.reduce((sum, vector) => sum + vector[dimension] / unit.length, 0),
  );
  const magnitude = Math.sqrt(
    centroid.reduce((sum, value) => sum + value * value, 0),
  );
  const center =
    magnitude > 1e-12 ? centroid.map((value) => value / magnitude) : undefined;
  const relevance = unit.map((vector) =>
    center ? (dot(vector, center) + 1) / 2 : 0.5,
  );
  // Content density and lexical variety are modest salience signals, not engagement predictions.
  const salience = candidates.map((candidate) => {
    const tokens =
      candidate.text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const unique = new Set(tokens).size;
    return (
      Math.min(1, tokens.length / 18) *
      (tokens.length ? unique / tokens.length : 0)
    );
  });
  const chosen: number[] = [];
  while (chosen.length < Math.min(limit, candidates.length)) {
    let best = -1,
      bestValue = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (
        chosen.includes(i) ||
        chosen.some(
          (j) =>
            candidates[i].start < candidates[j].end &&
            candidates[i].end > candidates[j].start,
        )
      )
        continue;
      const redundancy = chosen.length
        ? Math.max(...chosen.map((j) => Math.max(0, dot(unit[i], unit[j]))))
        : 0;
      const value =
        0.62 * relevance[i] + 0.08 * salience[i] - 0.38 * redundancy;
      if (value > bestValue) {
        best = i;
        bestValue = value;
      }
    }
    if (best < 0) break;
    chosen.push(best);
  }
  return chosen.map((index) => {
    const candidate = candidates[index];
    const title = candidate.text.trim().replace(/\s+/g, " ");
    return {
      ...candidate,
      id: `clip-${index}-${candidate.start}-${candidate.end}`,
      title: title.length > 64 ? `${title.slice(0, 61)}…` : title,
      score: relevance[index],
    };
  });
}
