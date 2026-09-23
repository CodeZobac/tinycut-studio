import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const fixture = resolve(".fixtures/scenes.webm");

test("empty editor is honest, responsive, and gates third-party models", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Make room for the good parts." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export MP4", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Enhance audio", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: /I have read and agree/ }),
  ).not.toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("real import, scene scan, edits, project round-trip, caption timing, and MP4 export without uploads", async ({
  page,
}, testInfo) => {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => {
    if (!["GET", "HEAD"].includes(r.method())) writes.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByLabel("Import video file", { exact: true })
    .setInputFiles(fixture);
  await expect(
    page.getByRole("button", { name: "Export MP4", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  await expect(page.locator(".bars i")).toHaveCount(140);
  await page.getByRole("tab", { name: "Scenes", exact: true }).click();
  await page
    .getByRole("button", { name: "Detect scenes", exact: true })
    .click();
  await expect(page.locator(".scene-row")).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator(".scene-row")).toContainText("00:04.0");
  await page.getByLabel("Selection start in seconds").fill("1");
  await page.getByLabel("Selection end in seconds").fill("7");
  await page.getByRole("button", { name: "Set range", exact: true }).click();
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(page.getByLabel("Selection start in seconds")).toHaveValue("0");
  await page.getByLabel("Selection start in seconds").fill("1");
  await page.getByLabel("Selection end in seconds").fill("7");
  await page.getByRole("button", { name: "Set range", exact: true }).click();
  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const projectPath = await (await projectDownload).path();
  const project = JSON.parse(await readFile(projectPath!, "utf8"));
  // Deliberately seeded project edit data tests restoration/export, NOT AI detection.
  project.fillers = [{ start: 3, end: 4, confidence: 0.9 }];
  project.checked = [0];
  project.words = [
    { text: "before", start: 1.2, end: 2.0 },
    { text: "cut", start: 3.1, end: 3.8 },
    { text: "after", start: 4.2, end: 5.0 },
  ];
  await page
    .getByLabel("Open TinyCut project JSON")
    .setInputFiles({
      name: "edits.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
  await expect(page.locator(".status-message")).toContainText(
    "Project restored",
  );
  await page.getByRole("tab", { name: "Fillers", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: /Remove filler 1/ }),
  ).toBeChecked();
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  const captionDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download edited SRT" }).click();
  const srt = await readFile((await (await captionDownload).path())!, "utf8");
  expect(srt).toContain("before");
  expect(srt).toContain("after");
  expect(srt).not.toMatch(/\bcut\b/);
  expect(srt).toContain("00:00:00,200");
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export MP4", exact: true }).click();
  const exportPath = testInfo.outputPath("edited.mp4");
  await (await exported).saveAs(exportPath);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        exportPath,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(Math.abs(Number(probe.format.duration) - 5)).toBeLessThan(0.15);
  expect(probe.streams.map((s: any) => s.codec_name)).toEqual(
    expect.arrayContaining(["h264", "aac"]),
  );
  execFileSync("ffmpeg", ["-v", "error", "-i", exportPath, "-f", "null", "-"]);
  await writeFile(
    testInfo.outputPath("probe.json"),
    JSON.stringify(probe, null, 2),
  );
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("malformed projects and invalid ranges show errors rather than changing edits", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Open TinyCut project JSON")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"format":"not-tinycut"}'),
    });
  await expect(page.getByRole("alert")).toContainText(
    "Invalid TinyCut project",
  );
  await page
    .getByLabel("Import video file", { exact: true })
    .setInputFiles(fixture);
  await expect(
    page.getByRole("button", { name: "Export MP4", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  await page.getByLabel("Selection start in seconds").fill("7");
  await page.getByLabel("Selection end in seconds").fill("2");
  await page.getByRole("button", { name: "Set range", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Set a start before the end",
  );
});
