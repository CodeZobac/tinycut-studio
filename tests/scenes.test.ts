import { afterEach, describe, expect, it, vi } from "vitest";
import { detectScenes, frameDifference } from "../src/lib/scenes";

const rgba = (...values: number[]) => new Uint8ClampedArray(values);

describe("frameDifference", () => {
  it("returns zero for identical RGB and ignores alpha", () =>
    expect(frameDifference(rgba(12, 34, 56, 0), rgba(12, 34, 56, 255))).toBe(
      0,
    ));
  it("returns one for black to white", () =>
    expect(frameDifference(rgba(0, 0, 0, 255), rgba(255, 255, 255, 255))).toBe(
      1,
    ));
  it("averages absolute RGB differences across all pixels", () => {
    expect(
      frameDifference(
        rgba(0, 0, 0, 255, 255, 255, 255, 255),
        rgba(255, 255, 255, 255, 255, 255, 255, 255),
      ),
    ).toBe(0.5);
  });
  it("is symmetric and supports Uint8Array", () => {
    const a = new Uint8Array([10, 20, 30, 255]),
      b = new Uint8Array([40, 15, 60, 255]);
    expect(frameDifference(a, b)).toBeCloseTo(65 / 765);
    expect(frameDifference(a, b)).toBe(frameDifference(b, a));
  });
  it("rejects empty, malformed and differently sized buffers", () => {
    expect(() => frameDifference(rgba(), rgba())).toThrow(RangeError);
    expect(() => frameDifference(rgba(1, 2, 3), rgba(1, 2, 3))).toThrow(
      RangeError,
    );
    expect(() =>
      frameDifference(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0, 0, 0, 0, 0)),
    ).toThrow(RangeError);
  });
});

type Options = {
  stallLoad?: boolean;
  stallSeek?: boolean;
  codecError?: boolean;
  duration?: number;
  noVideo?: boolean;
  constant?: boolean;
  pixelError?: boolean;
  noCanvas?: boolean;
};
function fixture(options: Options = {}) {
  class Video extends EventTarget {
    readyState = 0;
    duration = options.duration ?? 3;
    videoWidth = options.noVideo ? 0 : 1920;
    videoHeight = options.noVideo ? 0 : 1080;
    seeking = false;
    src = "";
    preload = "";
    muted = false;
    playsInline = false;
    error: { message: string } | null = null;
    private time = 0;
    sought: number[] = [];
    pause = vi.fn();
    remove = vi.fn();
    removeAttribute = vi.fn(() => {
      this.src = "";
    });
    load = vi.fn(() => {
      if (!this.src || options.stallLoad) return;
      queueMicrotask(() => {
        if (options.codecError) {
          this.error = { message: "Unsupported test codec" };
          this.dispatchEvent(new Event("error"));
          return;
        }
        this.readyState = 1;
        this.dispatchEvent(new Event("loadedmetadata"));
        queueMicrotask(() => {
          this.readyState = 2;
          this.dispatchEvent(new Event("loadeddata"));
        });
      });
    });
    get currentTime() {
      return this.time;
    }
    set currentTime(value: number) {
      this.time = value;
      this.sought.push(value);
      this.seeking = true;
      this.readyState = 1;
      if (options.stallSeek) return;
      queueMicrotask(() => {
        this.seeking = false;
        this.dispatchEvent(new Event("seeked"));
        // Simulate decoded pixels becoming available only AFTER seeked.
        queueMicrotask(() => {
          this.readyState = 2;
          this.dispatchEvent(new Event("loadeddata"));
        });
      });
    }
  }
  const video = new Video();
  const drawImage = vi.fn(() => {
    if (options.pixelError) throw new Error("Cannot read pixels");
    if (video.readyState < 2 || video.seeking)
      throw new Error("Read before decoded frame");
  });
  const canvas = {
    width: 0,
    height: 0,
    remove: vi.fn(),
    getContext: vi.fn(() =>
      options.noCanvas
        ? null
        : {
            drawImage,
            getImageData: () => {
              const value =
                options.constant || video.currentTime < 1
                  ? 0
                  : Math.round(video.currentTime * 2) % 2 === 0
                    ? 255
                    : 0;
              const data = new Uint8ClampedArray(64 * 36 * 4);
              for (let i = 0; i < data.length; i += 4) {
                data[i] = value;
                data[i + 1] = value;
                data[i + 2] = value;
                data[i + 3] = 255;
              }
              return { data };
            },
          },
    ),
  };
  vi.stubGlobal("document", {
    createElement: (tag: string) => (tag === "video" ? video : canvas),
  });
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:test-local");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const file = new File(["test fixture"], "fixture.mp4", { type: "video/mp4" });
  const progress = vi.fn();
  return { video, canvas, drawImage, create, revoke, file, progress };
}
const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("detectScenes browser media orchestration", () => {
  it("samples decoded frames every half second, enforces one-second spacing and cleans up", async () => {
    const f = fixture();
    await expect(detectScenes(f.file, 0.2, f.progress)).resolves.toEqual([
      1, 2,
    ]);
    expect(f.video.sought).toEqual([0.5, 1, 1.5, 2, 2.5]);
    expect(f.drawImage).toHaveBeenCalledTimes(6);
    expect(f.drawImage).toHaveBeenCalledWith(f.video, 0, 0, 64, 36);
    expect(f.video.pause).toHaveBeenCalled();
    expect(f.video.src).toBe("");
    expect(f.video.remove).toHaveBeenCalled();
    expect(f.canvas.width).toBe(0);
    expect(f.revoke).toHaveBeenCalledWith("blob:test-local");
    expect(f.progress).toHaveBeenLastCalledWith(
      "Scene detection complete: 2 cuts found.",
    );
  });
  it("does not classify unchanged frames as cuts even at threshold zero", async () => {
    const f = fixture({ constant: true });
    await expect(detectScenes(f.file, 0, f.progress)).resolves.toEqual([]);
  });
  it("supports threshold one and sub-half-second videos", async () => {
    const f = fixture({ duration: 0.2 });
    await expect(detectScenes(f.file, 1, f.progress)).resolves.toEqual([]);
    expect(f.video.sought).toEqual([]);
    expect(f.drawImage).toHaveBeenCalledOnce();
  });
  it("rejects unsupported codecs and releases the blob", async () => {
    const f = fixture({ codecError: true });
    await expect(detectScenes(f.file, 0.3, f.progress)).rejects.toThrow(
      "codec",
    );
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it.each([NaN, Infinity, 0, -1])(
    "rejects unreadable duration %s",
    async (duration) => {
      const f = fixture({ duration });
      await expect(detectScenes(f.file, 0.3, f.progress)).rejects.toThrow(
        "finite duration",
      );
      expect(f.revoke).toHaveBeenCalledOnce();
    },
  );
  it("rejects a file with no video track", async () => {
    const f = fixture({ noVideo: true });
    await expect(detectScenes(f.file, 0.3, f.progress)).rejects.toThrow(
      "video track",
    );
  });
  it.each([-0.1, 1.1, NaN, Infinity])(
    "rejects invalid threshold %s before creating a URL",
    async (threshold) => {
      const f = fixture();
      await expect(detectScenes(f.file, threshold, f.progress)).rejects.toThrow(
        RangeError,
      );
      expect(f.create).not.toHaveBeenCalled();
    },
  );
  it("rejects empty files before creating a URL", async () => {
    const f = fixture();
    await expect(
      detectScenes(new File([], "empty.mp4"), 0.2, f.progress),
    ).rejects.toThrow("nonempty");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("rejects missing canvas support without leaking a URL", async () => {
    const f = fixture({ noCanvas: true });
    await expect(detectScenes(f.file, 0.2, f.progress)).rejects.toThrow(
      "Canvas",
    );
    expect(f.create).not.toHaveBeenCalled();
  });
  it("cleans up after canvas pixel-reading errors", async () => {
    const f = fixture({ pixelError: true });
    await expect(detectScenes(f.file, 0.2, f.progress)).rejects.toThrow(
      "decoded video pixels",
    );
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it("rejects an already-aborted signal without creating media resources", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectScenes(f.file, 0.2, f.progress, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("cancels while a seek is stalled and still cleans up", async () => {
    const f = fixture({ stallSeek: true });
    const controller = new AbortController();
    const promise = detectScenes(f.file, 0.2, f.progress, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    await flushMicrotasks();
    expect(f.video.sought).toEqual([0.5]);
    controller.abort();
    await assertion;
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it("cancels while metadata is stalled", async () => {
    const f = fixture({ stallLoad: true });
    const controller = new AbortController();
    const promise = detectScenes(f.file, 0.2, f.progress, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await assertion;
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it.each(["load", "seek"])(
    "times out a stalled %s instead of hanging",
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture({
        stallLoad: stage === "load",
        stallSeek: stage === "seek",
      });
      const assertion = expect(
        detectScenes(f.file, 0.2, f.progress),
      ).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(15001);
      await assertion;
      expect(f.revoke).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("cleans up when the progress callback throws", async () => {
    const f = fixture();
    await expect(
      detectScenes(f.file, 0.2, () => {
        throw new Error("UI unmounted");
      }),
    ).rejects.toThrow("UI unmounted");
    expect(f.revoke).toHaveBeenCalledOnce();
  });
});
