import { describe, expect, it } from "vitest";
import {
  resampleMono,
  uhmWindow,
  groupFillerFrames,
} from "../src/workers/ai-dsp";
const rms = (a: Float32Array) =>
  Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
describe("real DSP, not model inference", () => {
  it("preserves duration and voice band in 48k to 16k resampling", () => {
    const wave = Float32Array.from({ length: 48000 }, (_, i) =>
      Math.sin((2 * Math.PI * 1000 * i) / 48000),
    );
    const down = resampleMono(wave, 48000);
    expect(down.length).toBe(16000);
    expect(rms(down)).toBeCloseTo(Math.SQRT1_2, 3);
  });
  it("suppresses out-of-band aliasing rather than simple decimation", () => {
    const wave = Float32Array.from({ length: 48000 }, (_, i) =>
      Math.sin((2 * Math.PI * 12000 * i) / 48000),
    );
    expect(rms(resampleMono(wave, 48000).slice(100, -100))).toBeLessThan(0.001);
  });
  it("normalizes unpadded samples with sample standard deviation then pads zeros", () => {
    const result = uhmWindow(new Float32Array([1, 2, 3]), 0, 5);
    expect(result[0]).toBeCloseTo(-1);
    expect(result[1]).toBe(0);
    expect(result[2]).toBeCloseTo(1);
    expect([...result.slice(3)]).toEqual([0, 0]);
  });
  it("constant audio stays finite", () => {
    expect([...uhmWindow(new Float32Array([2, 2, 2]), 0, 5)]).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });
  it("groups acoustic posteriors into source seconds", () => {
    const result = groupFillerFrames(
      new Float32Array([0, 0, 0.9, 0.9, 0.9, 0.9, 0.9, 0]),
      0.16,
    );
    expect(result).toHaveLength(1);
    expect(result[0].start).toBeCloseTo(0.04);
    expect(result[0].end).toBeCloseTo(0.14);
  });
  it("does not turn silence or tiny blips into cuts", () => {
    expect(groupFillerFrames(new Float32Array([0, 0.8, 0]), 0.06)).toEqual([]);
  });
  it("ignores nonfinite frames without getting stuck", () => {
    expect(
      groupFillerFrames(new Float32Array([NaN, Infinity, 0]), 0.06),
    ).toEqual([]);
  });
});
