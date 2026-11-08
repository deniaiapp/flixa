import chalk from "chalk";
import { Command } from "commander";
import { getApiKey } from "../auth/service.ts";
import {
  getDefaultProvider,
  getPersistedProviderBaseUrl,
  setDefaultProvider,
} from "../config/store.ts";
import {
  getProviderDefinition,
  isProviderId,
  listProviderDefinitions,
  type ProviderId,
} from "../providers/registry.ts";

export function registerProvidersCommand(program: Command): void {
  const providers = program
    .command("providers")
    .description("Inspect and configure BYOK providers");

  providers
    .command("list")
    .description("List supported providers and whether they are configured")
    .action(() => {
      const defaultProvider = getDefaultProvider();
      const rows = listProviderDefinitions().map((provider) => {
        const configured = Boolean(getApiKey(provider.id));
        const baseUrl = getPersistedProviderBaseUrl(provider.id) ?? provider.defaultBaseUrl ?? "-";
        return {
          provider: provider.id,
          status: configured ? "configured" : "missing",
          default: provider.id === defaultProvider ? "yes" : "no",
          baseUrl,
        };
      });

      const providerWidth = Math.max("Provider".length, ...rows.map((row) => row.provider.length));
      const statusWidth = Math.max("Status".length, ...rows.map((row) => row.status.length));
      const defaultWidth = Math.max("Default".length, ...rows.map((row) => row.default.length));
      console.log(
        chalk.bold(
          `${"Provider".padEnd(providerWidth)}  ${"Status".padEnd(statusWidth)}  ${"Default".padEnd(defaultWidth)}  Base URL`,
        ),
      );
      for (const row of rows) {
        console.log(
          `${row.provider.padEnd(providerWidth)}  ${row.status.padEnd(statusWidth)}  ${row.default.padEnd(defaultWidth)}  ${row.baseUrl}`,
        );
      }
    });

  providers
    .command("current")
    .description("Show the current default provider")
    .action(() => {
      const provider = getDefaultProvider();
      console.log(
        `${chalk.green("Default provider:")} ${getProviderDefinition(provider).displayName} ${chalk.dim(`(${provider})`)}`,
      );
    });

  providers
    .command("set-default <provider>")
    .description("Set the default provider")
    .action((rawProvider: string) => {
      const provider = parseProvider(rawProvider);
      setDefaultProvider(provider);
      console.log(
        `${chalk.green("✓ Default provider set:")} ${getProviderDefinition(provider).displayName}`,
      );
    });
}

function parseProvider(rawProvider: string): ProviderId {
  const normalized = rawProvider.trim().toLowerCase();
  if (!isProviderId(normalized)) {
    throw new Error(`Unsupported provider: ${rawProvider}`);
  }
  return normalized;
}
