import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL = "https://models.dev/api.json";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = join(scriptDir, "..", "src", "providers", "models-dev.generated.ts");

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`models.dev request failed: ${response.status} ${response.statusText}`);
}

const catalog = await response.json();
const providers = Object.values(catalog)
  .filter((provider) => provider && typeof provider === "object")
  .map((provider) => ({
    id: provider.id,
    name: provider.name,
    npm: provider.npm,
    api: provider.api ?? null,
    env: Array.isArray(provider.env) ? provider.env : [],
    models: selectFeaturedModels(provider.models),
  }))
  .filter(
    (provider) =>
      typeof provider.id === "string" &&
      typeof provider.name === "string" &&
      typeof provider.npm === "string",
  )
  .sort((left, right) => left.id.localeCompare(right.id));

const source = [
  "// Generated from https://models.dev/api.json.",
  "// Refresh with: pnpm run providers:update",
  "",
  "export interface ModelsDevGeneratedModel {",
  "  id: string;",
  "  name: string;",
  "  description: string;",
  "  toolCall: boolean;",
  "}",
  "",
  "export interface ModelsDevGeneratedProvider {",
  "  id: string;",
  "  name: string;",
  "  npm: string;",
  "  api: string | null;",
  "  env: string[];",
  "  models: ModelsDevGeneratedModel[];",
  "}",
  "",
  `export const MODELS_DEV_PROVIDERS: ModelsDevGeneratedProvider[] = ${JSON.stringify(providers, null, 2)};`,
  "",
].join("\n");

writeFileSync(outputPath, source, "utf8");
console.log(`Updated ${providers.length} providers from models.dev.`);

function selectFeaturedModels(rawModels) {
  if (!rawModels || typeof rawModels !== "object") {
    return [];
  }

  return Object.values(rawModels)
    .filter((model) => {
      const outputModalities = model?.modalities?.output;
      return (
        typeof model?.id === "string" &&
        Array.isArray(outputModalities) &&
        outputModalities.includes("text")
      );
    })
    .sort((left, right) => {
      const toolCallScore = Number(Boolean(right.tool_call)) - Number(Boolean(left.tool_call));
      if (toolCallScore !== 0) {
        return toolCallScore;
      }

      return String(right.last_updated ?? right.release_date ?? "").localeCompare(
        String(left.last_updated ?? left.release_date ?? ""),
      );
    })
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
      description:
        typeof model.description === "string"
          ? model.description.replace(/\s+/g, " ").trim().slice(0, 180)
          : "",
      toolCall: Boolean(model.tool_call),
    }));
}
