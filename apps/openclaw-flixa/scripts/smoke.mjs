const plugin = await import("../dist/index.js");
const entry = plugin.default;

if (!entry || entry.id !== "flixa" || typeof entry.register !== "function") {
  throw new Error("OpenClaw Flixa plugin entry is invalid.");
}

console.log(`Loaded OpenClaw plugin ${entry.id}.`);
