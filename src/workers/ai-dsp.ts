/** Windowed-sinc mono resampling with anti-aliasing; no AudioContext in workers. */
export function resampleMono(
  input: Float32Array,
  from: number,
  to = 16000,
): Float32Array {
  if (from === to) return input;
  const output = new Float32Array(
    Math.max(1, Math.round((input.length * to) / from)),
  );
  const ratio = from / to;
  const cutoff = Math.min(1, to / from) * 0.95;
  const radius = Math.ceil(16 / cutoff);
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    const center = Math.floor(position);
    let sum = 0,
      weight = 0;
    for (let j = center - radius + 1; j <= center + radius; j++) {
      if (j < 0 || j >= input.length) continue;
      const d = position - j;
      if (Math.abs(d) >= radius) continue;
      const x = Math.PI * d * cutoff;
      const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x;
      const w = cutoff * sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / radius));
      sum += input[j] * w;
      weight += w;
    }
    output[i] = weight ? sum / weight : 0;
  }
  return output;
}

/** Matches Desert Ant core 3.3.0 Sources/Uhm/Detector.swift, not the stale
 * five-class browser demo: sample std (N-1), epsilon, THEN zero padding. */
export function uhmWindow(
  audio: Float32Array,
  start: number,
  size = 480000,
): Float32Array {
  const n = Math.min(size, audio.length - start);
  const output = new Float32Array(size);
  if (n <= 0) return output;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += audio[start + i];
  mean /= n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += (audio[start + i] - mean) ** 2;
  const std = Math.sqrt(sumSq / Math.max(1, n - 1)) + 1e-7;
  for (let i = 0; i < n; i++) output[i] = (audio[start + i] - mean) / std;
  return output;
}

/** 20 ms posterior frames; precision-first suggestions, never automatic cuts. */
export function groupFillerFrames(probs: Float32Array, duration: number) {
  const spans: { start: number; end: number; confidence: number }[] = [];
  let i = 0;
  while (i < probs.length) {
    if (!Number.isFinite(probs[i]) || probs[i] < 0.75) {
      i++;
      continue;
    }
    let j = i,
      sum = 0;
    while (j < probs.length && Number.isFinite(probs[j]) && probs[j] >= 0.75)
      sum += probs[j++];
    const start = i * 0.02,
      end = Math.min(duration, j * 0.02);
    const confidence = sum / (j - i);
    const last = spans.at(-1);
    if (last && start - last.end <= 0.100001) {
      last.end = end;
      last.confidence = Math.max(last.confidence, confidence);
    } else if (end - start >= 0.099999) spans.push({ start, end, confidence });
    i = j;
  }
  return spans;
}
