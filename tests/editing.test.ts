import { describe, expect, it } from "vitest";
import {
  makeCandidates,
  mergeRanges,
  rankCandidates,
  subtractRanges,
  toSrt,
  type Word,
} from "../src/lib/editing";

describe("mergeRanges", () => {
  it("sorts, clamps and merges touching and overlapping ranges without mutation", () => {
    const input = [
      { start: 4, end: 7 },
      { start: -2, end: 2 },
      { start: 2, end: 5 },
      { start: 9, end: 12 },
    ];
    expect(mergeRanges(input, 10)).toEqual([
      { start: 0, end: 7 },
      { start: 9, end: 10 },
    ]);
    expect(input[0]).toEqual({ start: 4, end: 7 });
  });
  it("discards nonfinite, reversed, empty and out-of-bounds ranges", () => {
    expect(
      mergeRanges(
        [
          { start: NaN, end: 2 },
          { start: 0, end: Infinity },
          { start: 3, end: 2 },
          { start: 2, end: 2 },
          { start: -3, end: -1 },
          { start: 5, end: 6 },
        ],
        4,
      ),
    ).toEqual([]);
  });
  it("allows zero duration", () =>
    expect(mergeRanges([{ start: 0, end: 4 }], 0)).toEqual([]));
  it.each([NaN, Infinity, -1])("rejects invalid duration %s", (duration) =>
    expect(() => mergeRanges([], duration)).toThrow(RangeError),
  );
});

describe("subtractRanges", () => {
  it("subtracts unsorted overlapping cuts inside a selected clip", () => {
    expect(
      subtractRanges({ start: 10, end: 20 }, [
        { start: 14, end: 16 },
        { start: 12, end: 15 },
        { start: 19, end: 30 },
      ]),
    ).toEqual([
      { start: 10, end: 12 },
      { start: 16, end: 19 },
    ]);
  });
  it("ignores boundary-touching and external cuts", () => {
    expect(
      subtractRanges({ start: 3, end: 5 }, [
        { start: 0, end: 3 },
        { start: 5, end: 8 },
      ]),
    ).toEqual([{ start: 3, end: 5 }]);
  });
  it("supports full removal and invalid selections", () => {
    expect(
      subtractRanges({ start: 3, end: 5 }, [{ start: 0, end: 8 }]),
    ).toEqual([]);
    expect(subtractRanges({ start: NaN, end: 5 }, [])).toEqual([]);
    expect(subtractRanges({ start: -2, end: -1 }, [])).toEqual([]);
  });
  it("clamps selection to nonnegative time", () =>
    expect(subtractRanges({ start: -1, end: 3 }, [])).toEqual([
      { start: 0, end: 3 },
    ]));
});

describe("toSrt", () => {
  it("retimes a selection and removes cuts without retaining deleted text", () => {
    const words = [
      { text: "Before", start: 0, end: 1 },
      { text: "Hello.", start: 10, end: 11 },
      { text: "Deleted", start: 12, end: 13 },
      { text: "World!", start: 14, end: 15 },
    ];
    expect(
      toSrt(words, [
        { start: 10, end: 12 },
        { start: 14, end: 16 },
      ]),
    ).toBe(
      "1\n00:00:00,000 --> 00:00:01,000\nHello.\n\n2\n00:00:02,000 --> 00:00:03,000\nWorld!\n",
    );
  });
  it("clips boundary words and includes a cut-straddling word only once", () => {
    expect(
      toSrt(
        [{ text: "Entire", start: 0, end: 10 }],
        [
          { start: 2, end: 3 },
          { start: 7, end: 9 },
        ],
      ),
    ).toBe("1\n00:00:00,000 --> 00:00:03,000\nEntire\n");
  });
  it("merges overlapping keep ranges instead of double counting output time", () => {
    expect(
      toSrt(
        [{ text: "Hello", start: 3, end: 4 }],
        [
          { start: 2, end: 4 },
          { start: 0, end: 3 },
        ],
      ),
    ).toContain("00:00:03,000 --> 00:00:04,000");
  });
  it("omits boundary-touching, nonfinite and empty words", () => {
    expect(
      toSrt(
        [
          { text: "Out", start: 0, end: 1 },
          { text: "Bad", start: NaN, end: 2 },
          { text: " ", start: 1, end: 2 },
        ],
        [{ start: 1, end: 3 }],
      ),
    ).toBe("");
    expect(toSrt([{ text: "No", start: 0, end: 1 }], [])).toBe("");
  });
  it("sorts words, joins punctuation, and groups short speech", () => {
    expect(
      toSrt(
        [
          { text: "world", start: 1, end: 2 },
          { text: "Hello", start: 0, end: 1 },
          { text: "!", start: 2, end: 2.1 },
        ],
        [{ start: 0, end: 3 }],
      ),
    ).toBe("1\n00:00:00,000 --> 00:00:02,100\nHello world!\n");
  });
  it("splits on a long pause", () => {
    const result = toSrt(
      [
        { text: "One", start: 0, end: 1 },
        { text: "Two", start: 3, end: 4 },
      ],
      [{ start: 0, end: 4 }],
    );
    expect(result.match(/-->/g)).toHaveLength(2);
  });
  it("handles hour boundaries and millisecond rounding", () => {
    expect(
      toSrt(
        [{ text: "Hour", start: 3599.9996, end: 3600.501 }],
        [{ start: 0, end: 3601 }],
      ),
    ).toContain("01:00:00,000 --> 01:00:00,501");
  });
  it("does not emit zero-duration cues for tiny word intervals", () => {
    expect(
      toSrt([{ text: "Tiny", start: 0, end: 0.0001 }], [{ start: 0, end: 1 }]),
    ).toContain("00:00:00,000 --> 00:00:00,001");
  });
});

describe("makeCandidates", () => {
  const words: Word[] = [
    { text: "First", start: 1, end: 1.2 },
    { text: "sentence.", start: 1.8, end: 2 },
    { text: "Second!", start: 3, end: 5 },
    { text: "Final", start: 6, end: 6.2 },
    { text: "thought", start: 7.5, end: 8 },
  ];
  it("uses actual sentence starts and ends rather than fabricated equal-duration words", () => {
    expect(makeCandidates(words, 4)).toEqual([
      { start: 1, end: 5, text: "First sentence. Second!" },
      { start: 3, end: 8, text: "Second! Final thought" },
      { start: 6, end: 8, text: "Final thought" },
    ]);
  });
  it("does not split a long sentence to satisfy a target", () => {
    expect(
      makeCandidates(
        [
          { text: "Long", start: 0, end: 1 },
          { text: "sentence.", start: 19, end: 20 },
        ],
        5,
      ),
    ).toEqual([{ start: 0, end: 20, text: "Long sentence." }]);
  });
  it("recognizes quoted punctuation and ignores malformed words", () => {
    expect(
      makeCandidates(
        [
          { text: "Quoted!”", start: 0, end: 2 },
          { text: "Next.", start: 3, end: 5 },
          { text: "Bad", start: 5, end: Infinity },
        ],
        1,
      ),
    ).toHaveLength(2);
  });
  it("handles empty input and validates target", () => {
    expect(makeCandidates([], 5)).toEqual([]);
    for (const value of [0, -1, NaN, Infinity])
      expect(() => makeCandidates([], value)).toThrow(RangeError);
  });
});

describe("rankCandidates", () => {
  const candidates = [0, 1, 2, 3].map((i) => ({
    start: i * 10,
    end: i * 10 + 5,
    text: `Sentence ${i}.`,
  }));
  it("uses supplied embeddings for centrality and returns bounded relevance scores", () => {
    const ranked = rankCandidates(candidates.slice(0, 3), [
      [1, 0],
      [0.99, 0.1],
      [-1, 0],
    ]);
    expect(ranked[0].start).toBe(10);
    expect(ranked.at(-1)!.start).toBe(20);
    expect(
      ranked.every((c) => c.score >= 0 && c.score <= 1 && c.id && c.title),
    ).toBe(true);
  });
  it("favors diversity after the first selection when relevance is similar", () => {
    const ranked = rankCandidates(
      candidates,
      [
        [1, 0],
        [1, 0],
        [0.6, 0.8],
        [0.6, -0.8],
      ],
      2,
    );
    expect(ranked[0].start).toBe(0);
    expect(ranked[1].start).toBe(20);
  });
  it("never returns overlapping intervals but permits touching ones", () => {
    const overlapping = [
      { start: 0, end: 4, text: "One." },
      { start: 2, end: 5, text: "Two." },
      { start: 4, end: 6, text: "Three." },
    ];
    expect(rankCandidates(overlapping, [[1], [1], [1]])).toHaveLength(2);
  });
  it("is deterministic and handles cancelling centroid and large vectors", () => {
    const result = rankCandidates(candidates.slice(0, 2), [
      [1e308, 0],
      [-1e308, 0],
    ]);
    expect(result.map((c) => c.score)).toEqual([0.5, 0.5]);
    expect(result).toEqual(
      rankCandidates(candidates.slice(0, 2), [
        [1e308, 0],
        [-1e308, 0],
      ]),
    );
  });
  it("rejects missing, zero, nonfinite and mismatched embeddings", () => {
    expect(() => rankCandidates(candidates, [])).toThrow();
    for (const vectors of [[[0, 0]], [[NaN, 1]], [[Infinity]], [[]]]) {
      expect(() => rankCandidates(candidates.slice(0, 1), vectors)).toThrow();
    }
    expect(() =>
      rankCandidates(candidates.slice(0, 2), [[1], [1, 2]]),
    ).toThrow();
  });
  it("validates candidates and limit", () => {
    expect(() =>
      rankCandidates([{ start: NaN, end: 3, text: "Bad" }], [[1]]),
    ).toThrow();
    expect(() =>
      rankCandidates([{ start: 0, end: 3, text: "" }], [[1]]),
    ).toThrow();
    for (const limit of [-1, 1.5, NaN, Infinity])
      expect(() => rankCandidates([], [], limit)).toThrow();
  });
  it("supports empty input and zero limit", () => {
    expect(rankCandidates([], [])).toEqual([]);
    expect(rankCandidates(candidates, [[1], [1], [1], [1]], 0)).toEqual([]);
  });
});
