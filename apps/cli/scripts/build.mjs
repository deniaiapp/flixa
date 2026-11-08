import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

// Workspace packages are bundled (they are not published); everything else stays external.
const WORKSPACE_PACKAGES = [
  "@deniai/flixa-api-client",
  "@deniai/flixa-core",
  "@deniai/flixa-core/node",
];

/** @type {import("esbuild").Plugin} */
const bundleWorkspacePackages = {
  name: "bundle-workspace-packages",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@deniai\/flixa-(api-client|core)(\/node)?$/ }, (args) =>
      WORKSPACE_PACKAGES.includes(args.path) ? { path: require.resolve(args.path) } : undefined,
    );
  },
};

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
  plugins: [bundleWorkspacePackages],
  logLevel: "info",
});
