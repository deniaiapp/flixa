import chalk from "chalk";
import { select } from "@inquirer/prompts";
import type { Command } from "commander";
import { fetchAvailableModels, type FlixaModelDefinition } from "../flixa/api.ts";
import { getPersistedModel, setPersistedModel } from "../config/store.ts";
import {
  listProviderModelOptions,
  resolveProviderContext,
  type ProviderModelOption,
} from "../providers/runtime.ts";

type ModelCommandOptions = {
  provider?: string;
  baseUrl?: string;
};

export function registerModelCommand(program: Command): void {
  program
    .command("model")
    .description("Select or set the default model for a provider")
    .option("-p, --provider <provider>", "Provider to configure")
    .option("--base-url <url>", "Override the API base URL for providers that support it")
    .argument("[modelId]", "Model id to set directly")
    .action(async (modelId: string | undefined, options: ModelCommandOptions) => {
      const context = resolveProviderContext({
        provider: options.provider,
        baseUrl: options.baseUrl,
      });
      if (!context.apiKey) {
        console.error(
          chalk.red("✗ Not logged in.") +
            ` Run \`flixa login --provider ${context.provider}\` first.`,
        );
        process.exit(1);
      }

      try {
        if (context.provider !== "flixa") {
          const providerModels = await listProviderModelOptions({
            provider: context.provider,
            model: context.model,
            baseUrl: context.baseUrl,
          });
          const selectedModelId = modelId?.trim()
            ? (resolveRequestedProviderModel(providerModels, modelId.trim())?.id ?? modelId.trim())
            : (await promptForProviderModelSelection(context.provider, providerModels)).id;
          setPersistedModel(selectedModelId, context.provider);
          console.log(
            chalk.green("✓ Default model set:") +
              ` ${selectedModelId} ${chalk.dim(`(${context.provider})`)}`,
          );
          return;
        }

        const models = await fetchAvailableModels({
          apiKey: context.apiKey,
          baseUrl: context.baseUrl,
        });
        if (models.length === 0) {
          console.error(chalk.red("✗ No models available for this account."));
          process.exit(1);
        }

        const selectedModel = modelId?.trim()
          ? resolveRequestedModel(models, modelId.trim())
          : await promptForModelSelection(models);

        if (!selectedModel) {
          console.error(chalk.red(`✗ Model not found: ${modelId}`));
          process.exit(1);
        }

        setPersistedModel(selectedModel.id, context.provider);
        console.log(
          chalk.green("✓ Default model set:") +
            ` ${selectedModel.label} ${chalk.dim(`(${selectedModel.id})`)}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red("✗ Model selection failed:") + ` ${message}`);
        process.exit(1);
      }
    });
}

async function promptForModelSelection(
  models: readonly FlixaModelDefinition[],
): Promise<FlixaModelDefinition> {
  const currentModel = getPersistedModel("flixa");

  const selectedId = await select({
    message: "Select the default model",
    choices: models.map((model) => ({
      name:
        model.id === currentModel
          ? `${model.label} (${model.tier}) [current]`
          : `${model.label} (${model.tier})`,
      value: model.id,
      description:
        model.description ||
        [model.id, ...(Array.isArray(model.tags) ? model.tags : [])].filter(Boolean).join(" · "),
    })),
  });

  const selectedModel = models.find((model) => model.id === selectedId) ?? models[0];
  if (!selectedModel) {
    throw new Error("No Flixa models are available.");
  }
  return selectedModel;
}

async function promptForProviderModelSelection(
  provider: string,
  models: readonly ProviderModelOption[],
): Promise<ProviderModelOption> {
  const currentModel = getPersistedModel(resolveProviderContext({ provider }).provider);

  const selectedId = await select({
    message: `Select the default model for ${provider}`,
    choices: models.map((model) => ({
      name: model.id === currentModel ? `${model.label} [current]` : model.label,
      value: model.id,
      description: model.description || undefined,
    })),
  });

  const selectedModel = models.find((model) => model.id === selectedId) ?? models[0];
  if (!selectedModel) {
    throw new Error(`No models are available for ${provider}.`);
  }
  return selectedModel;
}

function resolveRequestedProviderModel(
  models: readonly ProviderModelOption[],
  modelId: string,
): ProviderModelOption | null {
  return (
    models.find((model) => model.id === modelId) ??
    models.find((model) => stripModelProvider(model.id) === stripModelProvider(modelId)) ??
    null
  );
}

function resolveRequestedModel(
  models: readonly FlixaModelDefinition[],
  modelId: string,
): FlixaModelDefinition | null {
  const exactMatch = models.find((model) => model.id === modelId);
  if (exactMatch) {
    return exactMatch;
  }

  const requestedSuffix = stripModelProvider(modelId);
  return models.find((model) => stripModelProvider(model.id) === requestedSuffix) ?? null;
}

function stripModelProvider(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  return slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);
}
