// Run from the project root: node src/workers/ai-prepare-assets.mjs
// Runtime assets ONLY, no model download and no license acceptance.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir, mkdir, copyFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function packageAt(entry, expected) {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      if (metadata.name === expected) return { directory, metadata };
    } catch {
      /* ascend past non-package dirs */
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot locate ${expected} package from ${entry}`);
}
async function copyRuntime(source, destination) {
  await mkdir(destination, { recursive: true });
  const names = (await readdir(source)).filter((name) =>
    /\.(wasm|mjs|js)$/.test(name),
  );
  if (!names.some((name) => name.endsWith(".wasm")))
    throw new Error(`No WASM assets in ${source}`);
  for (const name of names)
    await copyFile(join(source, name), join(destination, name));
  console.log(`Copied ${names.length} runtime assets: ${destination}`);
}
const tfEntry = require.resolve("@huggingface/transformers");
const tf = await packageAt(tfEntry, "@huggingface/transformers");
const clear = await packageAt(
  require.resolve("@desert-ant-labs/clear"),
  "@desert-ant-labs/clear",
);
const ort = await packageAt(
  require.resolve("onnxruntime-web"),
  "onnxruntime-web",
);
const tfRequire = createRequire(tfEntry);
const tfOrt = await packageAt(
  tfRequire.resolve("onnxruntime-web"),
  "onnxruntime-web",
);
const litert = await packageAt(
  require.resolve("@litertjs/core"),
  "@litertjs/core",
);
for (const [pkg, expected] of [
  [tf, "3.8.1"],
  [clear, "3.3.0"],
  [ort, "1.22.0"],
]) {
  if (pkg.metadata.version !== expected)
    throw new Error(
      `${pkg.metadata.name}: expected ${expected}, installed ${pkg.metadata.version}`,
    );
}
console.log(
  "Installed versions:",
  Object.fromEntries(
    [tf, clear, ort, litert].map((p) => [p.metadata.name, p.metadata.version]),
  ),
);
console.log("Transformers private ORT:", tfOrt.metadata.version);
await copyRuntime(join(ort.directory, "dist"), join(project, "public/ai/ort"));
await copyRuntime(
  join(tfOrt.directory, "dist"),
  join(project, "public/ai/transformers-ort"),
);
await copyRuntime(
  join(litert.directory, "wasm"),
  join(project, "public/ai/litert"),
);
// Clear's dist/index.js uses new URL('ClearWeb.wasm', import.meta.url): Vite
// emits this SDK WASM itself. Do not copy/modify the SDK or its telemetry.
