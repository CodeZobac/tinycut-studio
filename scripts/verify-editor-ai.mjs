// Opt-in real UI + open-model verification. Never accepts Desert Ant terms.
import { chromium } from "@playwright/test";
import { preview } from "vite";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = resolve(root, ".fixtures");
await mkdir(fixtures, { recursive: true });
const speech = await fetch(
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
);
if (!speech.ok) throw Error("Public speech fixture download failed");
await writeFile(
  resolve(fixtures, "speech.wav"),
  Buffer.from(await speech.arrayBuffer()),
);
const footage = resolve(fixtures, "speech.webm");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=s=480x270:r=12:d=11",
  "-i",
  resolve(fixtures, "speech.wav"),
  "-c:v",
  "libvpx-vp9",
  "-deadline",
  "realtime",
  "-cpu-used",
  "8",
  "-c:a",
  "libopus",
  "-shortest",
  footage,
]);
const server = await preview({ root, preview: { host: "127.0.0.1", port: 0 } });
const browser = await chromium.launch({ headless: true });
const report = { checks: [], errors: [], writes: [] };
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  page.setDefaultTimeout(180000);
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("request", (r) => {
    if (!["GET", "HEAD"].includes(r.method())) report.writes.push(r.url());
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page
    .getByLabel("Import video file", { exact: true })
    .setInputFiles(footage);
  await page
    .getByRole("button", { name: "Transcribe audio", exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent.includes("Transcribe audio"),
      )?.disabled,
  );
  await page.getByLabel("Speech language").selectOption("english");
  await page
    .getByRole("button", { name: "Transcribe audio", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".status-message")
        ?.textContent.includes("Transcript ready"),
    null,
    { timeout: 180000 },
  );
  const text = await page.locator(".transcript-words").innerText();
  assert(/country/i.test(text));
  report.words = await page.locator(".transcript-words button").count();
  assert(report.words > 10);
  report.checks.push("Real speech import and Whisper UI word timestamps");
  await page.getByRole("tab", { name: "Clips", exact: true }).click();
  await page
    .getByRole("button", { name: "Find candidates", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".status-message")
        ?.textContent.includes("candidates ready"),
    null,
    { timeout: 180000 },
  );
  report.clips = await page.locator(".result-card").count();
  assert(report.clips > 0);
  report.checks.push("Real MiniLM candidate ranking through UI");
  await page.locator(".result-card").first().click();
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download edited SRT" }).click();
  const srt = await readFile(await (await downloaded).path(), "utf8");
  assert(/country/i.test(srt));
  report.checks.push("Real transcript SRT download from selected highlight");
  assert.equal(
    await page
      .getByRole("checkbox", { name: /I have read and agree/ })
      .isChecked(),
    false,
  );
  report.checks.push("Desert Ant checkbox remains unchecked");
  await page.screenshot({
    path: resolve(root, "editor-verified.png"),
    fullPage: true,
  });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.writes, []);
  report.checks.push(
    "No page errors or non-GET/HEAD requests during this tested flow",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
  await writeFile(
    resolve(root, "editor-ai-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
}
