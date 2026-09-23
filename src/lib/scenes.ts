const WIDTH = 64;
const HEIGHT = 36;
const STEP_SECONDS = 0.5;
const MIN_GAP_SECONDS = 1;
const MEDIA_TIMEOUT_MS = 15000;

/** Mean absolute RGB change, normalized to [0,1]. RGBA alpha is intentionally ignored. */
export function frameDifference(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
): number {
  if (!a.length || a.length !== b.length || a.length % 4 !== 0) {
    throw new RangeError(
      "Frames must be nonempty RGBA buffers of equal length.",
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum +=
      Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3 * 255);
}

function abortError(): DOMException {
  return new DOMException("Scene detection cancelled.", "AbortError");
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
function codecError(video: HTMLVideoElement): Error {
  const detail = video.error?.message;
  return new Error(
    `Unable to decode this video. Its codec may not be supported by this browser.${detail ? ` ${detail}` : ""}`,
  );
}

/** Listeners are installed before an action, so cached/synchronous events cannot be missed. */
function waitForMedia(
  video: HTMLVideoElement,
  events: string[],
  ready: () => boolean,
  signal?: AbortSignal,
  action?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      events.forEach((event) => video.removeEventListener(event, inspect));
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", cancelled);
    };
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const inspect = () => {
      if (signal?.aborted) finish(abortError());
      else if (video.error) finish(codecError(video));
      else if (ready()) finish();
    };
    const failed = () => finish(codecError(video));
    const cancelled = () => finish(abortError());
    if (signal?.aborted) {
      finish(abortError());
      return;
    }
    events.forEach((event) => video.addEventListener(event, inspect));
    video.addEventListener("error", failed);
    signal?.addEventListener("abort", cancelled, { once: true });
    timer = setTimeout(
      () =>
        finish(
          new Error(
            "Video decoding timed out. Try a browser-supported video codec.",
          ),
        ),
      MEDIA_TIMEOUT_MS,
    );
    try {
      action?.();
      inspect();
    } catch (error) {
      finish(error);
    }
  });
}

async function decodedFrameAt(
  video: HTMLVideoElement,
  seconds: number,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  if (Math.abs(video.currentTime - seconds) > 0.0001 || video.seeking) {
    // A seeked event plus HAVE_CURRENT_DATA ensures this is the requested decoded frame.
    // requestVideoFrameCallback is deliberately not required: paused videos may never fire it.
    let seekFinished = false;
    const markSeeked = () => {
      seekFinished = true;
    };
    video.addEventListener("seeked", markSeeked);
    try {
      await waitForMedia(
        video,
        ["seeked", "loadeddata", "canplay"],
        () =>
          seekFinished &&
          !video.seeking &&
          video.readyState >= 2 &&
          Math.abs(video.currentTime - seconds) < 0.1,
        signal,
        () => {
          video.currentTime = seconds;
        },
      );
    } finally {
      video.removeEventListener("seeked", markSeeked);
    }
  } else {
    await waitForMedia(
      video,
      ["loadeddata", "canplay", "seeked"],
      () => !video.seeking && video.readyState >= 2,
      signal,
    );
  }
  checkAbort(signal);
}

/**
 * Samples this file's decoded frames every 0.5 seconds at 64×36. Returns source-time
 * cut markers (not 0/end boundaries), at least one second apart. No upload/network.
 * Browser-decoding support is required. Threshold is a finite RGB difference in [0,1].
 */
export async function detectScenes(
  file: File,
  threshold: number,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<number[]> {
  checkAbort(signal);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new RangeError("Scene threshold must be between 0 and 1.");
  if (!file || !Number.isFinite(file.size) || file.size <= 0)
    throw new Error("Choose a nonempty video file.");
  if (typeof document === "undefined")
    throw new Error(
      "Scene detection requires a browser with video and canvas support.",
    );
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("Canvas frame reading is not available in this browser.");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const source = URL.createObjectURL(file);
  try {
    onProgress("Loading video for local scene detection…");
    await waitForMedia(
      video,
      ["loadedmetadata", "loadeddata", "canplay"],
      () => video.readyState >= 1,
      signal,
      () => {
        video.src = source;
        video.load();
      },
    );
    if (
      !Number.isFinite(video.duration) ||
      video.duration <= 0 ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      throw new Error(
        "This file has no readable video track or finite duration. Try a browser-supported codec.",
      );
    }
    const duration = video.duration;
    await decodedFrameAt(video, 0, signal);
    const readFrame = (): Uint8ClampedArray => {
      checkAbort(signal);
      try {
        context.drawImage(video, 0, 0, WIDTH, HEIGHT);
        return context.getImageData(0, 0, WIDTH, HEIGHT).data;
      } catch (error) {
        throw new Error(
          `Unable to read decoded video pixels: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    let previous = readFrame();
    const cuts: number[] = [];
    // Treat the opening boundary as time zero so the first detected clip is >= 1 second.
    let lastCut = 0;
    for (let sample = 1; sample * STEP_SECONDS < duration; sample++) {
      const time = sample * STEP_SECONDS;
      await decodedFrameAt(video, time, signal);
      const frame = readFrame();
      if (
        frameDifference(previous, frame) > threshold &&
        time - lastCut >= MIN_GAP_SECONDS
      ) {
        cuts.push(time);
        lastCut = time;
      }
      previous = frame;
      onProgress(
        `Scanning scenes: ${Math.min(99, Math.floor((time / duration) * 100))}%`,
      );
    }
    checkAbort(signal);
    onProgress(
      `Scene detection complete: ${cuts.length} cut${cuts.length === 1 ? "" : "s"} found.`,
    );
    checkAbort(signal);
    return cuts;
  } finally {
    // Best-effort media teardown must not mask a decoder/cancellation failure.
    try {
      video.pause();
    } catch {
      /* already detached or failed */
    }
    try {
      video.removeAttribute("src");
      video.load();
    } catch {
      /* release URL regardless */
    }
    video.remove();
    canvas.remove();
    canvas.width = 0;
    canvas.height = 0;
    URL.revokeObjectURL(source);
  }
}
