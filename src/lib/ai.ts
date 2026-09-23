import workerUrl from "../workers/ai.worker?worker&url";

export type AITask = "transcribe" | "enhance" | "fillers" | "embed";
export interface AIOptions {
  language?: string;
  texts?: string[];
}
export interface AIResults {
  transcribe: {
    words: { text: string; start: number; end: number }[];
    text: string;
  };
  enhance: { samples: Float32Array; sampleRate: number };
  fillers: { fillers: { start: number; end: number; confidence: number }[] };
  embed: { vectors: number[][] };
}
export const DESERT_ANT_LICENSE_URL = "https://license.desertant.com/1.0";
let desertAntConsent = false;
/** Call ONLY from an explicit human license acknowledgment, never on app startup. */
export function setDesertAntConsent(accepted: boolean): void {
  desertAntConsent = accepted;
}

/** One disposable worker per job. Input PCM is copied, never detached from the editor. */
export function runAI<T extends AITask>(
  task: T,
  samples: Float32Array,
  sampleRate: number,
  options: AIOptions,
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<AIResults[T]> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("AI job cancelled", "AbortError"));
  if ((task === "enhance" || task === "fillers") && !desertAntConsent) {
    return Promise.reject(
      new Error(
        "Desert Ant license acknowledgment required. Review https://license.desertant.com/1.0 before downloading or running Clear or Uhm.",
      ),
    );
  }
  if (
    task !== "embed" &&
    (!(samples instanceof Float32Array) ||
      samples.length === 0 ||
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000)
  ) {
    return Promise.reject(
      new Error(
        "AI requires non-empty mono Float32 PCM and a valid 8–192 kHz sample rate.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    // Classic workers permit LiteRT importScripts. Serve the bootstrap beside
    // its WASM files because Emscripten uses the worker URL as its relative base.
    const moduleUrl = new URL(workerUrl, document.baseURI).href;
    const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
    const url = new URL("ai/litert/tinycut-bootstrap.js", baseUrl).href;
    let worker: Worker;
    let settled = false;
    const cleanup = () => {
      worker?.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const abort = () =>
      fail(new DOMException("AI job cancelled", "AbortError"));
    try {
      worker = new Worker(url, { name: `tinycut-${task}` });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      worker.onerror = (event) => {
        event.preventDefault();
        fail(
          new Error(
            event.message ||
              "AI worker failed to load. Check browser WASM support and asset paths.",
          ),
        );
      };
      worker.onmessageerror = () =>
        fail(new Error("AI worker returned an unreadable message."));
      worker.onmessage = (event) => {
        if (settled) return;
        const message = event.data;
        if (message.type === "progress") {
          // A UI callback must not orphan the worker if the component unmounts.
          try {
            progress(message.message);
          } catch {
            /* caller callback only */
          }
        } else if (message.type === "result") {
          settled = true;
          cleanup();
          resolve(message.result as AIResults[T]);
        } else if (message.type === "error") {
          fail(new Error(message.message));
        }
      };
      const copy = samples.slice();
      worker.postMessage(
        {
          task,
          samples: copy,
          sampleRate,
          options,
          desertAntConsent,
          baseUrl,
          moduleUrl,
        },
        [copy.buffer],
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
