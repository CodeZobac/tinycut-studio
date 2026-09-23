// Served beside LiteRT's WASM: Emscripten resolves worker-relative binaries
// against self.location. Blob URLs have no useful relative base.
self.onmessage = async (event) => {
  self.onmessage = null;
  try {
    const moduleUrl = new URL(event.data.moduleUrl);
    if (moduleUrl.origin !== self.location.origin)
      throw new Error("AI module must be same-origin");
    await import(moduleUrl.href);
    if (typeof self.onmessage !== "function")
      throw new Error("AI worker did not initialize");
    self.onmessage(event);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: String(error?.message || error),
    });
  }
};
