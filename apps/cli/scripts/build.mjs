import { build } from "esbuild";

// Bundle first-party sources into a single ESM file. Dependencies stay external
// and are resolved from node_modules at runtime (they are listed in "dependencies").
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  logLevel: "info",
});
