// Keeps acp-registry/flixa/agent.json in step with package.json.
// `node scripts/sync-acp-manifest.mjs` rewrites the manifest; `--check` fails if it is stale.
// Only the two version strings are rewritten, so the file keeps the repo's formatting.
import { readFile, writeFile } from "node:fs/promises";

const pkgUrl = new URL("../package.json", import.meta.url);
const manifestUrl = new URL("../acp-registry/flixa/agent.json", import.meta.url);

const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
const current = await readFile(manifestUrl, "utf8");
const manifest = JSON.parse(current);
const expectedPackage = `${pkg.name}@${pkg.version}`;
const isCurrent =
  manifest.version === pkg.version && manifest.distribution?.npx?.package === expectedPackage;

if (process.argv.includes("--check")) {
  if (!isCurrent) {
    console.error(
      `acp-registry/flixa/agent.json is out of date with ${expectedPackage}. Run: pnpm --filter ${pkg.name} acp:sync`,
    );
    process.exit(1);
  }
  console.log(`ACP manifest matches ${expectedPackage}.`);
} else if (isCurrent) {
  console.log("ACP manifest already up to date.");
} else {
  const next = current
    .replace(/("version"\s*:\s*)"[^"]*"/, `$1"${pkg.version}"`)
    .replace(/("package"\s*:\s*)"[^"]*"/, `$1"${expectedPackage}"`);
  await writeFile(manifestUrl, next);
  console.log(`Updated ACP manifest to ${expectedPackage}.`);
}
