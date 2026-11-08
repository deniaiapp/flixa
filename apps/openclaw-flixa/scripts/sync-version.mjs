import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(integrationRoot, "..", "..");
const rootPackagePath = join(repositoryRoot, "package.json");
const pluginPackagePath = join(integrationRoot, "package.json");

const rootPackage = readJson(rootPackagePath);
const pluginPackage = readJson(pluginPackagePath);
const releaseVersion = process.env.FLIXA_RELEASE_VERSION?.trim() || rootPackage.version;

if (typeof releaseVersion !== "string" || !releaseVersion) {
  throw new Error("The Flixa CLI package has no usable version.");
}

if (pluginPackage.version !== releaseVersion) {
  pluginPackage.version = releaseVersion;
  writeFileSync(pluginPackagePath, `${JSON.stringify(pluginPackage, null, 2)}\n`, "utf8");
}

console.log(`OpenClaw plugin version: ${releaseVersion}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
