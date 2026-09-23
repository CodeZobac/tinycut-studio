import { FFmpeg } from "@ffmpeg/ffmpeg";

export interface PCM {
  samples: Float32Array;
  sampleRate: number;
}
export interface KeepRange {
  start: number;
  end: number;
}
type Reporter = (message: string) => void;
// Keep the source voice bandwidth for Clear; ASR/Uhm resample inside their workers.
const RATE = 48000;
const SOURCE = "source-video";
const CANCEL_MESSAGE =
  "Media job cancelled. The media engine was terminated; reimport your video before continuing.";
const SCALE =
  "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";

function report(callback: Reporter, message: string): void {
  try {
    callback(message);
  } catch {
    /* UI callbacks must not orphan the worker. */
  }
}
function validatePCM({ samples, sampleRate }: PCM): void {
  if (
    !(samples instanceof Float32Array) ||
    !samples.length ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000
  ) {
    throw new Error(
      "Expected non-empty mono Float32 PCM at an integer sample rate between 8000 and 192000 Hz.",
    );
  }
}
/** Mono 16-bit WAV for preview/download; caller PCM is never detached or mutated. */
export function pcmToWav(samples: Float32Array, sampleRate: number): Blob {
  validatePCM({ samples, sampleRate });
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i])
      ? Math.max(-1, Math.min(1, samples[i]))
      : 0;
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** All times are seconds in the original source timeline, not the cut timeline. */
function validateRanges(ranges: KeepRange[], duration: number): KeepRange[] {
  if (!ranges.length)
    throw new Error("Keep at least one video interval before exporting.");
  let previousEnd = 0;
  return ranges.map(({ start, end }, index) => {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      (index > 0 && start < previousEnd)
    ) {
      throw new Error(
        "Keep intervals must be finite, positive-length, ordered, and non-overlapping.",
      );
    }
    if (end > duration + 0.1)
      throw new Error("A keep interval extends beyond the imported video.");
    const clampedEnd = Math.min(end, duration);
    if (clampedEnd <= start)
      throw new Error("A keep interval is outside the imported video.");
    previousEnd = end;
    return { start, end: clampedEnd };
  });
}
function graphFor(ranges: KeepRange[], enhanced: boolean): string {
  const n = ranges.length;
  const videoLabels = ranges.map((_, i) => `[vs${i}]`).join("");
  const audioLabels = ranges.map((_, i) => `[as${i}]`).join("");
  const filters = [
    `[0:v:0]setpts=PTS-STARTPTS,${SCALE},split=${n}${videoLabels}`,
    `[${enhanced ? "1:a:0" : "0:a:0"}]aresample=async=1:first_pts=0,apad,asplit=${n}${audioLabels}`,
  ];
  ranges.forEach(({ start, end }, i) => {
    filters.push(
      `[vs${i}]trim=start=${start.toFixed(6)}:end=${end.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`,
    );
    filters.push(
      `[as${i}]atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`,
    );
  });
  filters.push(
    `${ranges.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[vout][aout]`,
  );
  return filters.join(";");
}

/** One local video per engine. load() replaces the previous file; dispose/abort frees the WASM heap. */
export class MediaEngine {
  private ffmpeg: FFmpeg | null = null;
  private ready = false;
  private busy = false;
  private duration = 0;
  private pcmDuration = 0;
  private cancelActive: (() => void) | null = null;

  dispose(): void {
    this.cancelActive?.();
    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this.ready = false;
    this.duration = 0;
    this.pcmDuration = 0;
  }

  private async run<T>(
    signal: AbortSignal | undefined,
    work: (guard: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.busy)
      throw new Error(
        "Another media job is running. Wait for it or cancel it first.",
      );
    this.busy = true;
    let cancelled = false;
    let rejectCancellation: (reason: Error) => void = () => {};
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      this.ffmpeg?.terminate();
      this.ffmpeg = null;
      this.ready = false;
      this.duration = 0;
      this.pcmDuration = 0;
      rejectCancellation(new DOMException(CANCEL_MESSAGE, "AbortError"));
    };
    const guard = () => {
      if (cancelled) throw new DOMException(CANCEL_MESSAGE, "AbortError");
    };
    this.cancelActive = cancel;
    signal?.addEventListener("abort", cancel, { once: true });
    // Schedule work in a microtask so even an already-aborted signal is handled by the race.
    const operation = Promise.resolve().then(() => {
      guard();
      return work(guard);
    });
    if (signal?.aborted) cancel();
    try {
      return await Promise.race([operation, cancellation]);
    } catch (error) {
      if (cancelled) throw new DOMException(CANCEL_MESSAGE, "AbortError");
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.cancelActive = null;
      this.busy = false;
    }
  }

  async load(
    file: File,
    progress: Reporter,
    signal?: AbortSignal,
  ): Promise<PCM> {
    return this.run(signal, async (guard) => {
      // Replace the prior WASM instance rather than retaining old high-water memory.
      this.ffmpeg?.terminate();
      this.ready = false;
      this.duration = 0;
      this.pcmDuration = 0;
      const ff = new FFmpeg();
      this.ffmpeg = ff;
      const logs: string[] = [];
      const log = ({ message }: { message: string }) => {
        logs.push(message);
        if (logs.length > 20) logs.shift();
      };
      ff.on("log", log);
      try {
        if (!file.size) throw new Error("The selected file is empty.");
        report(progress, "Loading local video engine…");
        const base = new URL(import.meta.env.BASE_URL, document.baseURI);
        const assets = new URL("ffmpeg/", base);
        await ff.load({
          coreURL: new URL("ffmpeg-core.js", assets).href,
          wasmURL: new URL("ffmpeg-core.wasm", assets).href,
          classWorkerURL: new URL("worker.js", assets).href,
        });
        guard();
        report(progress, "Reading video locally…");
        const bytes = new Uint8Array(await file.arrayBuffer());
        guard();
        await ff.writeFile(SOURCE, bytes);
        guard();
        const probeCode = await ff.ffprobe([
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,duration:format=duration",
          "-of",
          "json",
          SOURCE,
          "-o",
          "probe.json",
        ]);
        guard();
        // core 0.12.10 ffprobe reports -1 (Aborted) even after writing complete valid JSON.
        // Its subsequent exec still works; validate the actual probe data rather than rejecting -1.
        if (probeCode !== 0 && probeCode !== -1)
          throw new Error(
            "Cannot read this video container. Try an MP4, MOV, or WebM file.",
          );
        const probeText = await ff.readFile("probe.json", "utf8");
        guard();
        const probe = JSON.parse(String(probeText)) as {
          streams?: { codec_type?: string; duration?: string }[];
          format?: { duration?: string };
        };
        const video = probe.streams?.find(
          (stream) => stream.codec_type === "video",
        );
        if (!video)
          throw new Error(
            "This file has no video track. Import a video with spoken audio.",
          );
        if (!probe.streams?.some((stream) => stream.codec_type === "audio")) {
          throw new Error(
            "This video has no audio track. TinyCut edits spoken content; import a video with audio.",
          );
        }
        const duration = Number(video.duration || probe.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0)
          throw new Error(
            "Could not determine video duration. Try remuxing the file to MP4 first.",
          );
        report(progress, "Decoding mono audio at 48 kHz…");
        logs.length = 0;
        const code = await ff.exec([
          "-i",
          SOURCE,
          "-map",
          "0:a:0",
          "-vn",
          "-af",
          `aresample=${RATE}:async=1:first_pts=0`,
          "-ac",
          "1",
          "-ar",
          String(RATE),
          "-c:a",
          "pcm_f32le",
          "-f",
          "f32le",
          "audio.f32",
        ]);
        guard();
        if (code !== 0)
          throw new Error(`Audio decode failed. ${logs.slice(-4).join(" ")}`);
        const data = await ff.readFile("audio.f32");
        guard();
        if (typeof data === "string" || !data.length || data.length % 4 !== 0)
          throw new Error(
            "The video audio track did not decode to usable PCM.",
          );
        const samples = new Float32Array(data.length / 4);
        const view = new DataView(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
        for (let i = 0; i < samples.length; i++)
          samples[i] = view.getFloat32(i * 4, true);
        await ff.deleteFile("audio.f32");
        await ff.deleteFile("probe.json");
        guard();
        this.duration = duration;
        this.pcmDuration = samples.length / RATE;
        this.ready = true;
        report(
          progress,
          "Video and audio ready. Everything stays on this device.",
        );
        return { samples, sampleRate: RATE };
      } catch (error) {
        // A failed import cannot leave a stale source available for export.
        ff.terminate();
        if (this.ffmpeg === ff) {
          this.ffmpeg = null;
          this.ready = false;
        }
        throw error;
      } finally {
        ff.off("log", log);
      }
    });
  }

  async exportVideo(
    ranges: KeepRange[],
    enhanced: PCM | null,
    progress: Reporter,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.run(signal, async (guard) => {
      const ff = this.ffmpeg;
      if (!ff || !this.ready)
        throw new Error(
          "Reimport your video before exporting. The media engine has no active source.",
        );
      const keep = validateRanges(ranges, this.duration);
      if (enhanced) {
        validatePCM(enhanced);
        if (
          Math.abs(
            enhanced.samples.length / enhanced.sampleRate - this.pcmDuration,
          ) > 0.25
        ) {
          throw new Error(
            "Enhanced audio must cover the full original audio timeline, not just the kept intervals.",
          );
        }
      }
      const logs: string[] = [];
      const log = ({ message }: { message: string }) => {
        logs.push(message);
        if (logs.length > 20) logs.shift();
      };
      let lastTime = -1;
      const total = keep.reduce((sum, item) => sum + item.end - item.start, 0);
      const onProgress = ({ time }: { time: number }) => {
        const seconds = Math.floor(time / 1e6);
        if (seconds > lastTime) {
          lastTime = seconds;
          report(
            progress,
            `Encoding MP4 locally… ${Math.min(seconds, Math.ceil(total))} / ${Math.ceil(total)} seconds`,
          );
        }
      };
      ff.on("log", log);
      ff.on("progress", onProgress);
      try {
        report(
          progress,
          enhanced
            ? "Preparing enhanced audio for export…"
            : "Preparing original audio for export…",
        );
        const args = ["-i", SOURCE];
        if (enhanced) {
          // Explicit little-endian f32 avoids WAV quantization and never transfers the caller's array.
          const raw = new Uint8Array(enhanced.samples.length * 4);
          const view = new DataView(raw.buffer);
          for (let i = 0; i < enhanced.samples.length; i++) {
            const value = enhanced.samples[i];
            view.setFloat32(i * 4, Number.isFinite(value) ? value : 0, true);
          }
          await ff.writeFile("enhanced.f32", raw);
          guard();
          args.push(
            "-f",
            "f32le",
            "-ar",
            String(enhanced.sampleRate),
            "-ac",
            "1",
            "-i",
            "enhanced.f32",
          );
        }
        args.push(
          "-filter_complex_threads",
          "1",
          "-filter_complex",
          graphFor(keep, !!enhanced),
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-threads",
          "1",
          "-fps_mode",
          "vfr",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ar",
          "48000",
          "-movflags",
          "+faststart",
          "-map_metadata",
          "-1",
          "export.mp4",
        );
        report(progress, "Encoding exact keep intervals to H.264 / AAC MP4…");
        const code = await ff.exec(args);
        guard();
        if (code !== 0)
          throw new Error(`MP4 export failed. ${logs.slice(-5).join(" ")}`);
        const data = await ff.readFile("export.mp4");
        guard();
        if (typeof data === "string" || data.length < 100)
          throw new Error("MP4 export produced an empty or invalid file.");
        // Own an ArrayBuffer rather than a possibly SharedArrayBuffer-backed view.
        const blob = new Blob([new Uint8Array(data)], { type: "video/mp4" });
        report(progress, "MP4 ready to download.");
        return blob;
      } finally {
        ff.off("log", log);
        ff.off("progress", onProgress);
        if (this.ffmpeg === ff && ff.loaded) {
          await Promise.all(
            ["enhanced.f32", "export.mp4"].map((path) =>
              ff.deleteFile(path).catch(() => {}),
            ),
          );
        }
      }
    });
  }
}
