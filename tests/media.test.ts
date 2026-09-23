import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Optional real-browser integration: TINYCUT_REAL_MEDIA=1 npx vitest run tests/media.test.ts
// Requires prepared assets, native ffmpeg/ffprobe on PATH, and Playwright Chromium installed.

const mock = vi.hoisted(() => ({
  instances: [] as any[],
  audio: true,
  failExport: false,
  waitExport: false,
}));
vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    loaded = false;
    files = new Map<string, Uint8Array | string>();
    on = vi.fn();
    off = vi.fn();
    load = vi.fn(async () => {
      this.loaded = true;
      return true;
    });
    terminate = vi.fn(() => {
      this.loaded = false;
      this.files.clear();
    });
    writeFile = vi.fn(async (name: string, value: Uint8Array) => {
      this.files.set(name, value);
      return true;
    });
    readFile = vi.fn(async (name: string) => this.files.get(name)!);
    deleteFile = vi.fn(async (name: string) => this.files.delete(name));
    ffprobe = vi.fn(async () => {
      this.files.set(
        "probe.json",
        JSON.stringify({
          streams: [
            { codec_type: "video", duration: "10" },
            ...(mock.audio ? [{ codec_type: "audio" }] : []),
          ],
          format: { duration: "10" },
        }),
      );
      return -1; // Real @ffmpeg/core 0.12.10 writes valid JSON but reports -1.
    });
    exec = vi.fn(async (args: string[]) => {
      if (args.at(-1) === "audio.f32")
        this.files.set(
          "audio.f32",
          new Uint8Array(new Float32Array(480000).buffer),
        );
      else {
        if (mock.waitExport) return new Promise<number>(() => {});
        if (mock.failExport) return 1;
        this.files.set("export.mp4", new Uint8Array(1024));
      }
      return 0;
    });
    constructor() {
      mock.instances.push(this);
    }
  },
}));
import { MediaEngine, pcmToWav } from "../src/lib/media";
const file = () =>
  new File([new Uint8Array([1, 2, 3])], "speech.mp4", { type: "video/mp4" });
const reporter = () => {};
beforeEach(() => {
  mock.instances.length = 0;
  mock.audio = true;
  mock.failExport = false;
  mock.waitExport = false;
  vi.stubGlobal("document", { baseURI: "http://localhost:5173/" });
});

describe("PCM WAV", () => {
  it("writes little-endian mono WAV, clamps samples, and preserves the input", async () => {
    const samples = new Float32Array([-2, -0.5, 0, 0.5, 2, NaN]);
    const original = samples.slice();
    const wav = pcmToWav(samples, 16000);
    const bytes = await wav.arrayBuffer();
    const view = new DataView(bytes);
    expect(wav.type).toBe("audio/wav");
    expect(bytes.byteLength).toBe(56);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(52, true)).toBe(32767);
    expect(view.getInt16(54, true)).toBe(0);
    expect(samples).toEqual(original);
  });
  it("rejects empty PCM and invalid sample rates", () => {
    expect(() => pcmToWav(new Float32Array(), 16000)).toThrow();
    expect(() => pcmToWav(new Float32Array(4), 0)).toThrow();
  });
});

describe("MediaEngine lifecycle and commands (mock worker)", () => {
  it("decodes PCM and retains only the immutable source in FS", async () => {
    const engine = new MediaEngine();
    const input = file();
    const audio = await engine.load(input, reporter);
    const ff = mock.instances[0];
    expect(audio.sampleRate).toBe(48000);
    expect(audio.samples.length).toBe(480000);
    expect([...ff.files.keys()]).toEqual(["source-video"]);
    expect(input.size).toBe(3);
    expect(ff.load.mock.calls[0][0]).toEqual({
      coreURL: "http://localhost:5173/ffmpeg/ffmpeg-core.js",
      wasmURL: "http://localhost:5173/ffmpeg/ffmpeg-core.wasm",
      classWorkerURL: "http://localhost:5173/ffmpeg/worker.js",
    });
    engine.dispose();
    expect(ff.terminate).toHaveBeenCalled();
  });
  it("trims the same source intervals in both tracks, reencodes, and cleans intermediates", async () => {
    const engine = new MediaEngine();
    await engine.load(file(), reporter);
    const blob = await engine.exportVideo(
      [
        { start: 1, end: 3 },
        { start: 6, end: 8 },
      ],
      null,
      reporter,
    );
    const ff = mock.instances[0];
    const args = ff.exec.mock.calls[1][0] as string[];
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("trim=start=1.000000:end=3.000000");
    expect(graph).toContain("atrim=start=6.000000:end=8.000000");
    expect(graph).toContain("concat=n=2:v=1:a=1");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(blob.type).toBe("video/mp4");
    expect(blob.size).toBeGreaterThan(0);
    expect([...ff.files.keys()]).toEqual(["source-video"]);
  });
  it("replaces original audio with full-timeline enhancement without detaching it", async () => {
    const engine = new MediaEngine();
    const audio = await engine.load(file(), reporter);
    await engine.exportVideo([{ start: 0, end: 2 }], audio, reporter);
    const args = mock.instances[0].exec.mock.calls[1][0] as string[];
    expect(args).toContain("enhanced.f32");
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("[1:a:0]");
    expect(audio.samples.byteLength).toBe(1920000);
    await expect(
      engine.exportVideo(
        [{ start: 0, end: 2 }],
        { samples: new Float32Array(16000), sampleRate: 16000 },
        reporter,
      ),
    ).rejects.toThrow("full original");
  });
  it("requires audio and invalidates failed imports", async () => {
    mock.audio = false;
    const engine = new MediaEngine();
    await expect(engine.load(file(), reporter)).rejects.toThrow(
      "no audio track",
    );
    await expect(
      engine.exportVideo([{ start: 0, end: 1 }], null, reporter),
    ).rejects.toThrow("Reimport");
    expect(mock.instances[0].terminate).toHaveBeenCalled();
  });
  it("rejects empty, overlapping, out-of-order, nonfinite, and out-of-bounds ranges", async () => {
    const engine = new MediaEngine();
    await engine.load(file(), reporter);
    for (const ranges of [
      [],
      [{ start: 0, end: 0 }],
      [{ start: NaN, end: 1 }],
      [{ start: 0, end: 11 }],
      [
        { start: 2, end: 5 },
        { start: 4, end: 6 },
      ],
    ]) {
      await expect(
        engine.exportVideo(ranges, null, reporter),
      ).rejects.toThrow();
    }
  });
  it("failed export cleans intermediates but allows retry", async () => {
    const engine = new MediaEngine();
    const audio = await engine.load(file(), reporter);
    mock.failExport = true;
    await expect(
      engine.exportVideo([{ start: 0, end: 1 }], audio, reporter),
    ).rejects.toThrow("export failed");
    expect([...mock.instances[0].files.keys()]).toEqual(["source-video"]);
    mock.failExport = false;
    expect(
      (await engine.exportVideo([{ start: 0, end: 1 }], null, reporter)).size,
    ).toBeGreaterThan(0);
  });
  it("abort terminates the active worker immediately and explicitly requires reimport", async () => {
    const engine = new MediaEngine();
    await engine.load(file(), reporter);
    mock.waitExport = true;
    const controller = new AbortController();
    const job = engine.exportVideo(
      [{ start: 0, end: 1 }],
      null,
      reporter,
      controller.signal,
    );
    const result = expect(job).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringContaining("reimport"),
    });
    await vi.waitFor(() =>
      expect(mock.instances[0].exec).toHaveBeenCalledTimes(2),
    );
    controller.abort();
    await result;
    expect(mock.instances[0].terminate).toHaveBeenCalled();
    await expect(
      engine.exportVideo([{ start: 0, end: 1 }], null, reporter),
    ).rejects.toThrow("Reimport");
    mock.waitExport = false;
    await expect(engine.load(file(), reporter)).resolves.toHaveProperty(
      "sampleRate",
      48000,
    );
  });
  it("already-aborted signals terminate existing source and do not start more work", async () => {
    const engine = new MediaEngine();
    await engine.load(file(), reporter);
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.exportVideo(
        [{ start: 0, end: 1 }],
        null,
        reporter,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.instances[0].exec).toHaveBeenCalledTimes(1);
  });
  it("replaces old imports and rejects simultaneous operations", async () => {
    const engine = new MediaEngine();
    const first = engine.load(file(), reporter);
    await expect(engine.load(file(), reporter)).rejects.toThrow(
      "Another media job",
    );
    await first;
    await engine.load(file(), reporter);
    expect(mock.instances[0].terminate).toHaveBeenCalled();
    expect(mock.instances.length).toBe(2);
  });
});

it.skipIf(process.env.TINYCUT_REAL_MEDIA !== "1")(
  "real Chromium: decode, trim/concat, resize, replace audio, and cancel",
  async () => {
    const { createServer } = await import("vite");
    const { chromium } = await import("@playwright/test");
    const root = fileURLToPath(new URL("..", import.meta.url));
    const source = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1600x900:rate=12:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=4",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { maxBuffer: 10000000 },
    );
    const silentVideo = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
      ],
      { input: source, maxBuffer: 10000000 },
    );
    const server = await createServer({
      configFile: false,
      root,
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "media-test-page",
          configureServer(s) {
            s.middlewares.use("/__media_test__", (_req, res) => {
              res.setHeader("Content-Type", "text/html");
              res.end(
                "<!doctype html><html><body>Real media test</body></html>",
              );
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const address = server.httpServer!.address() as { port: number };
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/__media_test__`);
      const result = await page.evaluate(
        async ({ source, silentVideo }) => {
          // Keep Vitest's SSR dynamic-import transform out of this browser-only callback.
          const { MediaEngine } = await new Function(
            'return import("/src/lib/media.ts")',
          )();
          const toFile = (base64: string) =>
            new File(
              [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
              "source.mp4",
              { type: "video/mp4" },
            );
          const engine = new MediaEngine();
          let noAudioError = "";
          try {
            await engine.load(toFile(silentVideo), () => {});
          } catch (error) {
            noAudioError = String(error);
          }
          const audio = await engine.load(toFile(source), () => {});
          const keep = [
            { start: 0.5, end: 1.5 },
            { start: 2.5, end: 3.5 },
          ];
          const original = await engine.exportVideo(keep, null, () => {});
          const enhanced = await engine.exportVideo(
            keep,
            {
              samples: new Float32Array(audio.samples.length),
              sampleRate: audio.sampleRate,
            },
            () => {},
          );
          const metadata = await new Promise<{
            duration: number;
            width: number;
            height: number;
            playbackError?: string;
            canPlay?: string;
          }>((resolve) => {
            const video = document.createElement("video");
            const url = URL.createObjectURL(original);
            video.onloadedmetadata = () => {
              resolve({
                duration: video.duration,
                width: video.videoWidth,
                height: video.videoHeight,
              });
              URL.revokeObjectURL(url);
            };
            video.onerror = () => {
              URL.revokeObjectURL(url);
              resolve({
                duration: 0,
                width: 0,
                height: 0,
                playbackError: video.error?.message,
                canPlay: video.canPlayType(
                  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
                ),
              });
            };
            video.src = url;
          });
          const abort = new AbortController();
          const job = engine.exportVideo(keep, null, () => {}, abort.signal);
          const timer = setTimeout(() => abort.abort(), 20);
          let cancelError = "";
          try {
            await job;
          } catch (error) {
            cancelError = String(error);
          } finally {
            clearTimeout(timer);
          }
          let reimportError = "";
          try {
            await engine.exportVideo(keep, null, () => {});
          } catch (error) {
            reimportError = String(error);
          }
          engine.dispose();
          const toBase64 = async (blob: Blob) => {
            let text = "";
            for (const byte of new Uint8Array(await blob.arrayBuffer()))
              text += String.fromCharCode(byte);
            return btoa(text);
          };
          return {
            original: await toBase64(original),
            enhanced: await toBase64(enhanced),
            metadata,
            noAudioError,
            cancelError,
            reimportError,
            sampleRate: audio.sampleRate,
            samples: audio.samples.length,
            isolated: crossOriginIsolated,
          };
        },
        {
          source: source.toString("base64"),
          silentVideo: silentVideo.toString("base64"),
        },
      );
      expect(result.sampleRate).toBe(48000);
      expect(result.samples).toBeGreaterThan(189000);
      if (result.metadata.playbackError) {
        expect(result.metadata.canPlay).toBe(""); // Some bundled Chromium builds omit proprietary playback codecs.
      } else {
        expect(result.metadata.duration).toBeCloseTo(2, 1);
        expect(result.metadata.width).toBe(1280);
        expect(result.metadata.height).toBe(720);
      }
      expect(result.noAudioError).toContain("no audio track");
      expect(result.cancelError).toContain("reimport");
      expect(result.reimportError).toContain("Reimport");
      expect(result.isolated).toBe(false);
      const metrics: Record<string, unknown> = {
        ...result.metadata,
        samples: result.samples,
        isolated: result.isolated,
      };
      for (const kind of ["original", "enhanced"] as const) {
        const bytes = Buffer.from(result[kind], "base64");
        // ffprobe can exit successfully before reading the whole stdin; status=0 + JSON is authoritative (EPIPE is benign).
        const probe = spawnSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,width,height:format=duration",
            "-of",
            "json",
            "pipe:0",
          ],
          { input: bytes },
        );
        expect(probe.status).toBe(0);
        const data = JSON.parse(probe.stdout.toString());
        expect(
          data.streams.map((s: { codec_name: string }) => s.codec_name),
        ).toEqual(["h264", "aac"]);
        expect(data.streams[0].width).toBe(1280);
        expect(data.streams[0].height).toBe(720);
        expect(Number(data.format.duration)).toBeCloseTo(2, 1);
        // Fully decode the output video, not just its container header.
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-xerror",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-f",
            "null",
            "-",
          ],
          { input: bytes, maxBuffer: 10000000 },
        );
        const decoded = execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "f32le",
            "pipe:1",
          ],
          { input: bytes, maxBuffer: 10000000 },
        );
        let squares = 0;
        for (let i = 0; i < decoded.length; i += 4)
          squares += decoded.readFloatLE(i) ** 2;
        const rms = Math.sqrt(squares / (decoded.length / 4));
        if (kind === "original") expect(rms).toBeGreaterThan(0.01);
        else expect(rms).toBeLessThan(0.0001);
        metrics[kind] = {
          bytes: bytes.length,
          rms,
          codecs: data.streams,
          duration: data.format.duration,
        };
      }
      console.log("Real browser media metrics:", JSON.stringify(metrics));
    } finally {
      await browser.close();
      await server.close();
    }
  },
  120000,
);
