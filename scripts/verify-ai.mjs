// Opt-in real browser smoke. Never acknowledges Desert Ant licensing or loads its models.
// node scripts/verify-ai.mjs [--models] [--fixture=/absolute/speech.wav]
// Chromium must already be installed: PLAYWRIGHT_BROWSERS_PATH=/agent/.cache/ms-playwright
import { build, preview } from "vite";
import { chromium } from "@playwright/test";
import { mkdtemp, writeFile, readdir, rm, copyFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(dirname(project), "ai-smoke-"));
const models = process.argv.includes("--models");
const fixture = process.argv.find((x) => x.startsWith("--fixture="))?.slice(10);
const report = {
  modelsOptIn: models,
  checks: [],
  requestsFailed: [],
  responsesFailed: [],
  console: [],
  results: {},
};
let browser, server;
try {
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><body>AI production smoke<script type="module" src="/entry.ts"></script></body></html>',
  );
  await writeFile(
    join(root, "entry.ts"),
    `import {runAI} from ${JSON.stringify(join(project, "src/lib/ai.ts"))}; window.runAI=runAI; window.ready=true;`,
  );
  await build({
    configFile: false,
    root,
    publicDir: join(project, "public"),
    worker: { format: "es" },
    build: { target: "esnext", outDir: join(root, "dist"), minify: true },
  });
  const assets = await readdir(join(root, "dist/assets"));
  report.assets = assets;
  assert(
    assets.some((x) => /^ClearWeb.*\.wasm$/.test(x)),
    "Clear SDK WASM missing from production bundle",
  );
  report.checks.push(
    "Production worker chunks and ClearWeb WASM emitted (static only)",
  );
  if (fixture) await copyFile(fixture, join(root, "dist/speech.wav"));
  server = await preview({
    configFile: false,
    root,
    build: { outDir: join(root, "dist") },
    preview: { host: "127.0.0.1", port: 0 },
  });
  const url = server.resolvedUrls.local[0];
  for (const directory of ["litert", "ort", "transformers-ort"]) {
    const filenames = await readdir(join(root, "dist/ai", directory));
    const wasm = filenames.find((name) => name.endsWith(".wasm"));
    assert(wasm, `${directory} WASM missing`);
    const response = await fetch(new URL(`ai/${directory}/${wasm}`, url), {
      method: "HEAD",
    });
    assert(
      response.ok &&
        response.headers.get("content-type")?.includes("application/wasm"),
      `${directory} WASM HTTP/MIME failure`,
    );
    report.checks.push(
      `${directory} runtime WASM static path HTTP 200 application/wasm (not initialized)`,
    );
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("requestfailed", (r) =>
    report.requestsFailed.push({ url: r.url(), error: r.failure()?.errorText }),
  );
  page.on("response", (r) => {
    if (r.status() >= 400)
      report.responsesFailed.push({ url: r.url(), status: r.status() });
  });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      report.console.push(m.text());
  });
  page.on("pageerror", (e) => report.console.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.ready);
  const basics = await page.evaluate(async () => {
    const checks = [];
    for (const task of ["enhance", "fillers"]) {
      try {
        await window.runAI(task, new Float32Array(16000), 16000, {}, () => {});
        throw Error("consent bypass");
      } catch (e) {
        if (!/acknowledgment/.test(e.message)) throw e;
        checks.push(task + " rejects without consent");
      }
    }
    const empty = await window.runAI(
      "embed",
      new Float32Array(),
      16000,
      {},
      () => {},
    );
    if (empty.vectors.length) throw Error("empty result contract");
    checks.push(
      "Actual classic Blob bootstrap imports production worker and completes empty embedding job",
    );
    const abort = new AbortController();
    const cancelled = window.runAI(
      "embed",
      new Float32Array(),
      16000,
      {},
      () => {},
      abort.signal,
    );
    abort.abort();
    try {
      await cancelled;
      throw Error("cancel ignored");
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    }
    checks.push("Cancellation rejects AbortError");
    return checks;
  });
  report.checks.push(...basics);
  if (models) {
    for (const task of ["embed", "transcribe"]) {
      report.results[task] = await page.evaluate(
        async ({ task, fixture }) => {
          const progress = [],
            controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 150000);
          try {
            let samples = new Float32Array(),
              sampleRate = 16000;
            if (task === "transcribe") {
              const response = await fetch(
                fixture
                  ? "/speech.wav"
                  : "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
              );
              if (!response.ok)
                throw Error(`Speech fixture HTTP ${response.status}`);
              const context = new AudioContext();
              try {
                const audio = await context.decodeAudioData(
                  await response.arrayBuffer(),
                );
                samples = audio.getChannelData(0).slice();
                sampleRate = audio.sampleRate;
              } finally {
                await context.close();
              }
            }
            const output = await window.runAI(
              task,
              samples,
              sampleRate,
              {
                language: "english",
                texts: [
                  "The cat sits on the mat.",
                  "Le chat est assis sur le tapis.",
                  "Quarterly revenue increased.",
                ],
              },
              (m) => progress.push(m),
              controller.signal,
            );
            if (task === "embed") {
              if (
                output.vectors.length !== 3 ||
                output.vectors.some(
                  (v) => v.length !== 384 || v.some((x) => !Number.isFinite(x)),
                )
              )
                throw Error("Invalid MiniLM vectors");
              const norms = output.vectors.map((v) =>
                Math.sqrt(v.reduce((s, x) => s + x * x, 0)),
              );
              if (norms.some((n) => Math.abs(n - 1) > 0.001))
                throw Error("Vectors not normalized");
              return {
                success: true,
                dimensions: output.vectors.map((v) => v.length),
                norms,
                progress,
              };
            }
            if (
              !output.text ||
              !output.words.length ||
              output.words.some(
                (w) =>
                  !(
                    w.start >= 0 &&
                    w.end > w.start &&
                    w.end <= samples.length / sampleRate
                  ),
              )
            )
              throw Error("Missing or invalid real word timing");
            return {
              success: true,
              output,
              duration: samples.length / sampleRate,
              progress,
            };
          } catch (e) {
            return { success: false, error: e.message, name: e.name, progress };
          } finally {
            clearTimeout(timer);
          }
        },
        { task, fixture: Boolean(fixture) },
      );
    }
  }
} catch (error) {
  report.fatal = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) =>
    server ? server.httpServer.close(resolve) : resolve(),
  );
  await writeFile(
    join(project, "ai-smoke-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        results: Object.fromEntries(
          Object.entries(report.results).map(([task, result]) => [
            task,
            { ...result, progress: result.progress?.slice(-5) },
          ]),
        ),
      },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
}
if (Object.values(report.results).some((r) => !r.success)) process.exitCode = 1;
