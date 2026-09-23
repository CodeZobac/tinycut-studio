// Explicit opt-in only: using/download of Desert Ant models is subject to its license.
// Run only after the human responsible for this app accepts https://license.desertant.com/1.0.
// node scripts/verify-desert-ant.mjs --accept-license
import { build, preview } from "vite";
import { chromium } from "@playwright/test";
import { mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
if (!process.argv.includes("--accept-license"))
  throw new Error(
    "Explicit human license acceptance required. Review https://license.desertant.com/1.0 before running with --accept-license.",
  );
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(dirname(project), "dal-smoke-"));
const report = {
  fixture: "First 3 seconds of public JFK speech fixture",
  checks: [],
  results: {},
  requestsFailed: [],
  responsesFailed: [],
  writes: [],
  console: [],
};
let browser, server;
try {
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html><body>Desert Ant explicit-consent verification<script type="module" src="/entry.ts"></script></body></html>',
  );
  await writeFile(
    join(root, "entry.ts"),
    `import {runAI,setDesertAntConsent} from ${JSON.stringify(join(project, "src/lib/ai.ts"))}; window.runAI=runAI; window.acceptLicense=()=>setDesertAntConsent(true); window.ready=true;`,
  );
  await build({
    configFile: false,
    root,
    publicDir: join(project, "public"),
    worker: { format: "es" },
    build: { target: "esnext", outDir: join(root, "dist"), minify: true },
  });
  const fixture = await fetch(
    "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
  );
  if (!fixture.ok)
    throw new Error(`Speech fixture download failed: ${fixture.status}`);
  await writeFile(
    join(root, "dist/speech.wav"),
    new Uint8Array(await fixture.arrayBuffer()),
  );
  server = await preview({
    configFile: false,
    root,
    build: { outDir: join(root, "dist") },
    preview: { host: "127.0.0.1", port: 0 },
  });
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
  page.on("request", (r) => {
    if (!["GET", "HEAD"].includes(r.method())) {
      let keys = [];
      try {
        keys = Object.keys(JSON.parse(r.postData() || "{}"));
      } catch {}
      report.writes.push({
        url: r.url(),
        method: r.method(),
        bytes: r.postDataBuffer()?.length || 0,
        keys,
      });
    }
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.acceptLicense());
  for (const task of ["enhance", "fillers"]) {
    report.results[task] = await page.evaluate(async (task) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      const progress = [];
      const started = performance.now();
      try {
        const response = await fetch("/speech.wav");
        const ctx = new AudioContext({ sampleRate: 48000 });
        let samples;
        try {
          const decoded = await ctx.decodeAudioData(
            await response.arrayBuffer(),
          );
          samples = decoded.getChannelData(0).slice(0, 144000);
        } finally {
          await ctx.close();
        }
        const result = await window.runAI(
          task,
          samples,
          48000,
          {},
          (s) => progress.push(s),
          controller.signal,
        );
        if (task === "enhance") {
          if (
            result.sampleRate !== 48000 ||
            !result.samples.length ||
            result.samples.some((x) => !Number.isFinite(x))
          )
            throw Error("Invalid enhanced PCM");
          if (
            Math.abs(
              result.samples.length / result.sampleRate -
                samples.length / 48000,
            ) > 0.1
          )
            throw Error("Enhanced audio duration mismatch");
          const rms = Math.sqrt(
            result.samples.reduce((s, x) => s + x * x, 0) /
              result.samples.length,
          );
          const inputRms = Math.sqrt(
            samples.reduce((s, x) => s + x * x, 0) / samples.length,
          );
          return {
            success: true,
            seconds: (performance.now() - started) / 1000,
            sampleRate: result.sampleRate,
            samples: result.samples.length,
            inputRms,
            outputRms: rms,
            progress,
          };
        }
        if (
          !Array.isArray(result.fillers) ||
          result.fillers.some(
            (f) =>
              !(
                f.start >= 0 &&
                f.end > f.start &&
                f.end <= samples.length / 48000 &&
                f.confidence >= 0 &&
                f.confidence <= 1
              ),
          )
        )
          throw Error("Invalid filler intervals");
        return {
          success: true,
          seconds: (performance.now() - started) / 1000,
          fillers: result.fillers,
          progress,
        };
      } catch (e) {
        return {
          success: false,
          error: e.message,
          name: e.name,
          seconds: (performance.now() - started) / 1000,
          progress,
        };
      } finally {
        clearTimeout(timeout);
      }
    }, task);
  }
} finally {
  await browser?.close();
  await new Promise((r) => (server ? server.httpServer.close(r) : r()));
  await writeFile(
    join(project, "desert-ant-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        results: Object.fromEntries(
          Object.entries(report.results).map(([k, v]) => [
            k,
            { ...v, progress: v.progress?.slice(-6) },
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
