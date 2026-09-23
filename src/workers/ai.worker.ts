import type { AIOptions, AIResults, AITask } from "../lib/ai";
import { groupFillerFrames, resampleMono, uhmWindow } from "./ai-dsp";

interface Job {
  task: AITask;
  samples: Float32Array;
  sampleRate: number;
  options: AIOptions;
  desertAntConsent: boolean;
  baseUrl: string;
}
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<Job>) => void) | null;
  __dalHttpDebug?: boolean;
  __dalFlushTelemetry?: () => Promise<boolean>;
};
const progress = (message: string) =>
  scope.postMessage({ type: "progress", message });
const asset = (job: Job, path: string) => new URL(path, job.baseUrl).href;

function downloadProgress(info: unknown) {
  const p = info as { status?: string; file?: string; progress?: number };
  if (p.status === "progress")
    progress(
      `Downloading ${p.file ?? "model"} · ${Math.round(p.progress ?? 0)}%`,
    );
  else if (p.status === "initiate" || p.status === "done")
    progress(
      `${p.status === "done" ? "Cached" : "Loading"} ${p.file ?? "model"}`,
    );
}

async function transformers(job: Job) {
  const module = await import("@huggingface/transformers");
  module.env.allowLocalModels = false;
  module.env.useBrowserCache = true;
  // This path MUST contain Transformers' own resolved ORT, not Uhm's ORT 1.22.
  if (module.env.backends.onnx.wasm) {
    module.env.backends.onnx.wasm.numThreads = 1;
    module.env.backends.onnx.wasm.proxy = false;
    module.env.backends.onnx.wasm.wasmPaths = asset(
      job,
      "ai/transformers-ort/",
    );
  }
  return module;
}

async function transcribe(job: Job): Promise<AIResults["transcribe"]> {
  progress("Loading multilingual Whisper Tiny · local WASM");
  const { pipeline } = await transformers(job);
  const recognizer = await pipeline(
    "automatic-speech-recognition",
    "Xenova/whisper-tiny",
    {
      device: "wasm",
      dtype: "q8",
      revision: "5332fcc35e32a33b86612b9a57a89be7906102b1",
      progress_callback: downloadProgress,
    },
  );
  try {
    // SDK options cannot add cross-attention tensors absent from an ONNX graph.
    // Fail before decoding instead of fabricating word timing or substituting models.
    const decoderOutputs = Object.values(recognizer.model.sessions).flatMap(
      (session) => (session.outputNames ?? []) as string[],
    );
    if (!decoderOutputs.some((name) => name.startsWith("cross_attentions"))) {
      throw new Error(
        "The pinned Xenova/whisper-tiny export has no cross-attention outputs required for word timestamps. An attention-enabled Whisper export must be explicitly configured before transcription can run; no substitute model or fabricated timing was used.",
      );
    }
    progress("Resampling mono audio to 16 kHz");
    const pcm = resampleMono(job.samples, job.sampleRate);
    progress(
      `Transcribing ${(pcm.length / 16000).toFixed(1)} seconds · word alignment runs locally`,
    );
    const language = job.options.language?.trim();
    const output = await recognizer(pcm, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      task: "transcribe",
      ...(language && language !== "auto" ? { language } : {}),
    });
    const result = Array.isArray(output) ? output[0] : output;
    const duration = job.samples.length / job.sampleRate;
    const words: AIResults["transcribe"]["words"] = [];
    let incomplete = 0;
    for (const chunk of result.chunks ?? []) {
      const [start, end] = chunk.timestamp;
      const text = chunk.text.trim();
      // Never invent equal-spaced timestamps for unaligned transcript words.
      if (
        start == null ||
        end == null ||
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      ) {
        incomplete++;
        continue;
      }
      const boundedStart = Math.max(0, Math.min(duration, start));
      const boundedEnd = Math.max(boundedStart, Math.min(duration, end));
      if (text && boundedEnd > boundedStart)
        words.push({ text, start: boundedStart, end: boundedEnd });
    }
    if (incomplete)
      progress(
        `${incomplete} unaligned word(s) omitted from editable timing; full text retained.`,
      );
    if (result.text.trim() && !words.length)
      throw new Error(
        "Whisper produced text but no valid word timestamps. No editable transcript was fabricated.",
      );
    return { text: result.text.trim(), words };
  } finally {
    await recognizer.dispose();
  }
}

async function embed(job: Job): Promise<AIResults["embed"]> {
  const texts = job.options.texts ?? [];
  if (!texts.length) return { vectors: [] };
  if (texts.some((text) => typeof text !== "string"))
    throw new Error("Embedding texts must be strings.");
  progress("Loading multilingual MiniLM embeddings · local WASM");
  const { pipeline } = await transformers(job);
  const extractor = await pipeline(
    "feature-extraction",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    {
      device: "wasm",
      dtype: "q8",
      revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
      progress_callback: downloadProgress,
    },
  );
  try {
    const vectors: number[][] = [];
    // Bounded batches avoid padding every passage to the longest document.
    for (let i = 0; i < texts.length; i += 4) {
      progress(
        `Embedding passages ${i + 1}–${Math.min(i + 4, texts.length)} of ${texts.length}`,
      );
      const output = await extractor(texts.slice(i, i + 4), {
        pooling: "mean",
        normalize: true,
      });
      const rows = output.tolist() as number[][];
      if (
        rows.some(
          (row) => row.length !== 384 || row.some((v) => !Number.isFinite(v)),
        )
      )
        throw new Error(
          "MiniLM returned invalid embedding dimensions or values.",
        );
      vectors.push(...rows);
      output.dispose();
    }
    return { vectors };
  } finally {
    await extractor.dispose();
  }
}

async function enhance(job: Job): Promise<AIResults["enhance"]> {
  progress("Loading Clear SDK · local WASM / LiteRT");
  // SDK-supported debug flush hook lets its *unaltered* usage reporting finish
  // before this job's worker is terminated. It never contains PCM or outputs.
  scope.__dalHttpDebug = true;
  const { Clear } = await import("@desert-ant-labs/clear");
  const clear = await Clear.load({
    accelerator: "wasm",
    litertWasmDir: asset(job, "ai/litert/"),
    onProgress: (fraction) =>
      progress(`Loading Clear model · ${Math.round(fraction * 100)}%`),
  });
  try {
    progress(
      "Enhancing with Clear · denoise, dereverb and podcast loudness mastering",
    );
    const result = await clear.enhance(job.samples, job.sampleRate, {
      channelMode: "mono",
      targetLUFS: "podcast",
      outputSampleRate: job.sampleRate,
    });
    if (
      !result.samples.length ||
      result.samples.some((value) => !Number.isFinite(value))
    )
      throw new Error(
        "Clear returned invalid audio. Original audio was not modified.",
      );
    return { samples: result.samples, sampleRate: result.sampleRate };
  } finally {
    try {
      if (scope.__dalFlushTelemetry) {
        progress("Finalizing Clear SDK usage reporting · no audio is uploaded");
        await scope.__dalFlushTelemetry();
      }
    } finally {
      clear.dispose();
    }
  }
}

/** Cache only verified HTTP-success model responses. Model fetch occurs ONLY
 * after the main adapter and worker both check explicit human license consent. */
async function fetchUhmModel(): Promise<Uint8Array> {
  const url =
    "https://huggingface.co/desert-ant-labs/uhm/resolve/a0445b85e2da898f19b3cb07cc3cf7f2ee47f05d/uhm.onnx";
  let cache: Cache | undefined;
  try {
    cache = await caches.open("tinycut-models-v1");
  } catch {
    /* private browsing / quota */
  }
  const cached = await cache?.match(url);
  if (cached) {
    progress("Loading cached Uhm model");
    return new Uint8Array(await cached.arrayBuffer());
  }
  progress("Downloading Uhm fp32 ONNX (~98 MB) · first use only");
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok)
    throw new Error(
      `Uhm model download failed: HTTP ${response.status}. No substitute detector was used.`,
    );
  const save = cache?.put(url, response.clone()).catch(() => {
    progress("Model cache unavailable; this download will not persist.");
  });
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    reported = 0;
  const total = Number(response.headers.get("content-length") || 0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.length;
    if (bytes - reported > 2 * 1024 * 1024) {
      reported = bytes;
      progress(
        `Downloading Uhm · ${(bytes / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ""}`,
      );
    }
  }
  await save;
  const model = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    model.set(chunk, offset);
    offset += chunk.length;
  }
  return model;
}

async function fillers(job: Job): Promise<AIResults["fillers"]> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = asset(job, "ai/ort/");
  const model = await fetchUhmModel();
  const sessionOptions: import("onnxruntime-web").InferenceSession.SessionOptions =
    {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      enableMemPattern: false,
      enableCpuMemArena: false,
      executionMode: "sequential",
    };
  progress("Compiling Uhm ONNX · single-thread WASM");
  let session = await ort.InferenceSession.create(model, sessionOptions);
  try {
    if (
      session.inputNames.length !== 1 ||
      session.inputNames[0] !== "audio" ||
      !session.outputNames.includes("probs")
    )
      throw new Error(
        "Uhm ONNX input/output contract changed; expected audio → probs.",
      );
    progress("Preparing 16 kHz mono acoustic analysis");
    const pcm = resampleMono(job.samples, job.sampleRate);
    const frames = Math.ceil(pcm.length / 320);
    const sums = new Float32Array(frames);
    const counts = new Uint8Array(frames);
    const offsets: number[] = [];
    for (let start = 0; start < pcm.length; start += 400000) {
      offsets.push(start);
      if (start + 480000 >= pcm.length) break;
    }
    for (let i = 0; i < offsets.length; i++) {
      progress(`Uhm acoustic detection · window ${i + 1} of ${offsets.length}`);
      const start = offsets[i];
      const input = new ort.Tensor(
        "float32",
        uhmWindow(pcm, start),
        [1, 480000],
      );
      const output = await session.run({ audio: input });
      try {
        const probs = output.probs;
        if (
          !probs ||
          probs.type !== "float32" ||
          probs.dims.length !== 3 ||
          probs.dims[0] !== 1 ||
          probs.dims[1] !== 1499 ||
          probs.dims[2] !== 6
        )
          throw new Error(
            "Uhm ONNX output shape changed; expected float32 [1,1499,6]. Stopping rather than interpreting the wrong class layout.",
          );
        const values = probs.data as Float32Array;
        const usable = Math.min(
          1499,
          Math.ceil(Math.min(480000, pcm.length - start) / 320),
        );
        const offset = start / 320;
        for (let t = 0; t < usable; t++) {
          const p = values[t * 6];
          if (!Number.isFinite(p) || p < -0.001 || p > 1.001)
            throw new Error("Uhm returned invalid probabilities.");
          sums[offset + t] += Math.max(0, Math.min(1, 1 - p));
          counts[offset + t]++;
        }
      } finally {
        input.dispose();
        for (const tensor of Object.values(output)) tensor.dispose();
      }
      // Reclaim ORT arenas during long recordings, as upstream browser SDK does.
      if ((i + 1) % 8 === 0 && i + 1 < offsets.length) {
        await session.release();
        session = await ort.InferenceSession.create(model, sessionOptions);
      }
    }
    for (let i = 0; i < frames; i++)
      sums[i] = counts[i] ? sums[i] / counts[i] : 0;
    return { fillers: groupFillerFrames(sums, pcm.length / 16000) };
  } finally {
    await session.release();
  }
}

async function runJob(job: Job) {
  try {
    if (
      (job.task === "enhance" || job.task === "fillers") &&
      !job.desertAntConsent
    )
      throw new Error(
        "Explicit Desert Ant license acknowledgment is required.",
      );
    if (
      job.task !== "embed" &&
      job.samples.some((value) => !Number.isFinite(value))
    )
      throw new Error("Audio contains non-finite samples.");
    let result: AIResults[AITask];
    switch (job.task) {
      case "transcribe":
        result = await transcribe(job);
        break;
      case "enhance":
        result = await enhance(job);
        break;
      case "fillers":
        result = await fillers(job);
        break;
      case "embed":
        result = await embed(job);
        break;
      default:
        throw new Error("Unknown local AI task.");
    }
    const transfer =
      "samples" in result ? [result.samples.buffer as ArrayBuffer] : [];
    scope.postMessage({ type: "result", result }, transfer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ type: "error", message: `${job.task}: ${message}` });
  }
}
// The classic bootstrap imports this ES module, then delivers its first message.
scope.onmessage = (event) => {
  void runJob(event.data);
};
