import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "esnext" },
  optimizeDeps: { exclude: ["@desert-ant-labs/clear"] },
  server: { host: "0.0.0.0" },
  preview: { host: "0.0.0.0" },
});
