// Synthetic, non-personal browser fixtures. Requires ffmpeg on PATH.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const folder = fileURLToPath(new URL("../.fixtures/", import.meta.url));
mkdirSync(folder, { recursive: true });
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "color=c=red:s=320x180:r=12:d=4",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=320x180:r=12:d=4",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=8",
  "-filter_complex",
  "[0:v][1:v]concat=n=2:v=1:a=0[v]",
  "-map",
  "[v]",
  "-map",
  "2:a",
  "-c:v",
  "libvpx-vp9",
  "-deadline",
  "realtime",
  "-cpu-used",
  "8",
  "-c:a",
  "libopus",
  folder + "scenes.webm",
]);
console.log("Created synthetic red/blue scene fixture with tone audio.");
