import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "integrations", "openclaw-flixa");
const repositoryRoot = join(root, "..", "..");
const rootPackage = readJson(join(repositoryRoot, "package.json"));
const packageJson = readJson(join(root, "package.json"));
const manifest = readJson(join(root, "openclaw.plugin.json"));
const entry = readFileSync(join(root, "src", "index.ts"), "utf8");
const skillPath = join(repositoryRoot, "skills", "flixa-ship", "SKILL.md");
const skill = readFileSync(skillPath, "utf8")
  .replace(/^\uFEFF/, "")
  .replace(/\r\n/g, "\n");

assert(
  packageJson.openclaw?.extensions?.[0] === "./src/index.ts",
  "source extension entry mismatch",
);
assert(
  packageJson.openclaw?.runtimeExtensions?.[0] === "./dist/index.js",
  "runtime extension entry mismatch",
);
assert(
  packageJson.version === rootPackage.version,
  "OpenClaw plugin version must match Flixa CLI version",
);
assert(manifest.id === "flixa", "manifest id must be flixa");
assert(manifest.cliBackends?.includes("flixa"), "manifest must own the flixa CLI backend");
assert(entry.includes("registerCliBackend"), "plugin must register a CLI backend");
assert(entry.includes('"ship"'), "plugin must launch Flixa Ship");
assert(entry.includes('"--json"'), "plugin must request JSON output");
assert(skill.startsWith("---\n"), "Flixa Ship skill must have frontmatter");
assert(skill.includes("name: flixa-ship"), "Flixa Ship skill name mismatch");
assert(skill.includes("gpt-5.6-sol"), "Flixa Ship skill must recommend the default model");

console.log("OpenClaw Flixa integration contract is valid.");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
