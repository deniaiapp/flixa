import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const distPath = new URL("../dist/index.js", import.meta.url);
const distSource = readFileSync(distPath, "utf8");

const normalizedSource = distSource.match(/^(#![^\r\n]*\r?\n)+/)
  ? distSource.replace(/^(#![^\r\n]*\r?\n)+/, "#!/usr/bin/env node\n")
  : `#!/usr/bin/env node\n${distSource}`;

writeFileSync(distPath, normalizedSource);

// Ensure the packed bin keeps an executable mode in non-Windows installs.
chmodSync(distPath, 0o755);
