import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/workers/ai.worker?worker&url", () => ({
  default: "/assets/ai.worker.js",
}));
import { runAI, setDesertAntConsent } from "../src/lib/ai";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: unknown) => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor(
    public url: string,
    public options: unknown,
  ) {
    FakeWorker.instances.push(this);
  }
}
const createObjectURL = vi.fn(() => "blob:test");
const revokeObjectURL = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  FakeWorker.instances = [];
  setDesertAntConsent(false);
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("document", { baseURI: "http://localhost/" });
  vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectURL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const input = () => new Float32Array([0.1, -0.2, 0.3]);
describe("AI main-thread lifecycle (mock transport, not model inference)", () => {
  it.each(["enhance", "fillers"] as const)(
    "%s requires explicit consent before creating a worker",
    async (task) => {
      await expect(runAI(task, input(), 16000, {}, vi.fn())).rejects.toThrow(
        /acknowledgment/,
      );
      expect(FakeWorker.instances).toHaveLength(0);
    },
  );
  it("rejects invalid audio preflight without creating a worker", async () => {
    await expect(
      runAI("transcribe", new Float32Array(), 16000, {}, vi.fn()),
    ).rejects.toThrow(/non-empty/);
    await expect(
      runAI("transcribe", input(), NaN, {}, vi.fn()),
    ).rejects.toThrow(/valid/);
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it("pre-aborted signal creates no worker", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAI("embed", input(), 16000, {}, vi.fn(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it("copies PCM and disposes after result; throwing progress callbacks cannot orphan worker", async () => {
    const samples = input();
    const promise = runAI("embed", samples, 16000, { texts: [] }, () => {
      throw Error("unmounted");
    });
    const worker = FakeWorker.instances[0];
    const [job, transfer] = worker.postMessage.mock.calls[0];
    expect(job.samples).not.toBe(samples);
    expect(job.samples).toEqual(samples);
    expect(transfer).toEqual([job.samples.buffer]);
    worker.onmessage?.({ data: { type: "progress", message: "test" } });
    worker.onmessage?.({ data: { type: "result", result: { vectors: [] } } });
    await expect(promise).resolves.toEqual({ vectors: [] });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(samples.byteLength).toBe(12);
  });
  it("active cancellation terminates the worker and ignores late output", async () => {
    const controller = new AbortController();
    const promise = runAI(
      "embed",
      input(),
      16000,
      {},
      vi.fn(),
      controller.signal,
    );
    const worker = FakeWorker.instances[0];
    controller.abort();
    worker.onmessage?.({ data: { type: "result", result: { vectors: [] } } });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
  it("propagates worker errors without success substitution", async () => {
    const promise = runAI("embed", input(), 16000, {}, vi.fn());
    const worker = FakeWorker.instances[0];
    worker.onmessage?.({
      data: { type: "error", message: "embed: model HTTP 403" },
    });
    await expect(promise).rejects.toThrow("embed: model HTTP 403");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("handles worker construction failure and revokes bootstrap URL", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw Error("CSP blocked worker");
        }
      },
    );
    await expect(runAI("embed", input(), 16000, {}, vi.fn())).rejects.toThrow(
      "CSP blocked worker",
    );
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
});

it("worker itself rejects Desert Ant jobs before loading either SDK/model", async () => {
  const postMessage = vi.fn();
  const scope: {
    postMessage: typeof postMessage;
    onmessage?: (event: unknown) => void;
  } = { postMessage };
  vi.stubGlobal("self", scope);
  await import("../src/workers/ai.worker");
  for (const task of ["enhance", "fillers"]) {
    scope.onmessage?.({
      data: {
        task,
        desertAntConsent: false,
        samples: input(),
        sampleRate: 16000,
        options: {},
        baseUrl: "http://localhost/",
      },
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "error",
      message: `${task}: Explicit Desert Ant license acknowledgment is required.`,
    });
  }
});
