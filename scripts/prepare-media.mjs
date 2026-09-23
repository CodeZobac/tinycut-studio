import { copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/ffmpeg");
// require.resolve selects the UMD entry. Copy the ESM core for the module class worker.
const core = resolve(dirname(require.resolve("@ffmpeg/core")), "../esm");
const ffmpeg = resolve(dirname(require.resolve("@ffmpeg/ffmpeg")), "../esm");
await mkdir(output, { recursive: true });
const files = [
  [core, "ffmpeg-core.js"],
  [core, "ffmpeg-core.wasm"],
  // A stable same-origin class worker avoids Vite dev dependency-optimizer worker URLs.
  [ffmpeg, "worker.js"],
  [ffmpeg, "const.js"],
  [ffmpeg, "errors.js"],
];
for (const [directory, file] of files) {
  const source = resolve(directory, file);
  const destination = resolve(output, file);
  const [sourceStat, destinationStat] = await Promise.all([
    stat(source),
    stat(destination).catch(() => null),
  ]);
  if (
    !destinationStat ||
    sourceStat.size !== destinationStat.size ||
    sourceStat.mtimeMs > destinationStat.mtimeMs
  ) {
    await copyFile(source, destination);
  }
}
console.log(
  "Prepared single-thread FFmpeg core and module worker in public/ffmpeg (no external CDN).",
);
