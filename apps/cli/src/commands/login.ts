import { Command } from "commander";
import open from "open";
import { input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import boxen from "boxen";
import {
  deleteCredentials,
  getApiKey,
  hasStoredCredentials,
  loginWithDeviceAuth,
  saveApiKey,
} from "../auth/service.ts";
import {
  getPersistedProviderBaseUrl,
  setDefaultProvider,
  setPersistedProviderBaseUrl,
} from "../config/store.ts";
import {
  getProviderDefinition,
  isProviderId,
  listProviderDefinitions,
  type ProviderId,
} from "../providers/registry.ts";

type LoginCommandOptions = {
  provider?: string;
  baseUrl?: string;
};

type LogoutCommandOptions = {
  provider?: string;
};

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with Flixa or save BYOK credentials for a supported provider")
    .option("-p, --provider <provider>", "Provider to configure")
    .option("--base-url <url>", "Custom base URL for providers that support it")
    .action(async (options: LoginCommandOptions) => {
      const provider = await resolveProviderOption(options.provider);
      const providerDefinition = getProviderDefinition(provider);
      const existing = getApiKey(provider);
      if (existing) {
        console.log(
          chalk.yellow(`Already logged in for ${providerDefinition.displayName}.`) +
            " Run `flixa logout" +
            (provider === "flixa" ? "" : ` --provider ${provider}`) +
            "` to log out first.",
        );
        return;
      }

      if (providerDefinition.authType === "device") {
        await runDeviceAuthLogin(provider);
      } else if (providerDefinition.authType === "environment") {
        runEnvironmentLogin(provider);
      } else {
        await runApiKeyLogin(provider, options.baseUrl);
      }

      setDefaultProvider(provider);
    });

  program
    .command("logout")
    .description("Remove stored credentials")
    .option("-p, --provider <provider>", "Provider to remove credentials for", "flixa")
    .action((options: LogoutCommandOptions) => {
      const provider = parseProvider(options.provider ?? "flixa");
      const providerDefinition = getProviderDefinition(provider);
      const hadCredentials = hasStoredCredentials(provider);

      deleteCredentials(provider);

      if (hadCredentials) {
        console.log(
          chalk.green("✓ Logged out.") +
            chalk.dim(`  Removed stored credentials for ${providerDefinition.displayName}.`),
        );
      } else {
        console.log(
          chalk.yellow("No stored credentials found.") +
            chalk.dim(`  ${providerDefinition.displayName} was already logged out.`),
        );
      }

      console.log(
        chalk.dim(
          "Claude Code settings are not changed by logout. Run `flixa claude-code` again if you want to point Claude Code at a different provider.",
        ),
      );
    });
}

async function resolveProviderOption(rawProvider: string | undefined): Promise<ProviderId> {
  if (rawProvider) {
    return parseProvider(rawProvider);
  }

  return select({
    message: "Select a provider to configure",
    choices: listProviderDefinitions().map((provider) => ({
      name: provider.displayName,
      value: provider.id,
      description:
        provider.authType === "device"
          ? "Browser-based device authentication"
          : provider.authType === "environment"
            ? "Use the provider's environment variables"
            : "Bring your own API key",
    })),
  });
}

function parseProvider(rawProvider: string): ProviderId {
  const normalized = rawProvider.trim().toLowerCase();
  if (!isProviderId(normalized)) {
    throw new Error(`Unsupported provider: ${rawProvider}`);
  }
  return normalized;
}

async function runDeviceAuthLogin(provider: ProviderId): Promise<void> {
  const openStyle = await select({
    message: "How would you like to open the authorization page?",
    choices: [
      {
        name: "Open browser automatically",
        value: "auto" as const,
        description: "Launch your default browser automatically",
      },
      {
        name: "Show URL (open manually)",
        value: "manual" as const,
        description: "For SSH sessions or headless environments",
      },
    ],
  });

  console.log();

  try {
    await loginWithDeviceAuth({
      provider,
      onUserCode(userCode, verificationUrl) {
        const box = boxen(
          [
            chalk.bold("Authorization required"),
            "",
            `${chalk.dim("Code")}  ${chalk.cyan.bold(userCode)}`,
            `${chalk.dim("URL")}   ${chalk.underline(verificationUrl)}`,
          ].join("\n"),
          {
            padding: 1,
            borderColor: "cyan",
            borderStyle: "round",
          },
        );
        console.log(box);

        if (openStyle === "auto") {
          open(verificationUrl).catch(() => {
            console.log(
              chalk.yellow("Could not open browser.") + " Please visit the URL above manually.",
            );
          });
        }

        console.log(chalk.dim("Waiting for authorization..."));
      },
      onSaved(backend, warning) {
        logSavedBackend(provider, backend, warning);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("\n" + chalk.red("✗ Login failed:") + " " + message);
    process.exit(1);
  }
}

async function runApiKeyLogin(provider: ProviderId, baseUrlOption?: string): Promise<void> {
  const providerDefinition = getProviderDefinition(provider);
  const apiKey = (
    await password({
      message: `${providerDefinition.displayName} API key`,
      mask: "*",
    })
  ).trim();

  if (!apiKey) {
    console.error(chalk.red("✗ Login failed:") + " API key cannot be empty.");
    process.exit(1);
  }

  // Resolve the base URL before storing anything, so a failed login leaves no key behind.
  let baseUrl = "";
  if (
    providerDefinition.defaultBaseUrl ||
    providerDefinition.baseUrlRequired ||
    provider === "custom-openai"
  ) {
    const persistedBaseUrl = getPersistedProviderBaseUrl(provider);
    baseUrl = (
      baseUrlOption ??
      (await input({
        message:
          provider === "custom-openai"
            ? "Base URL for your OpenAI-compatible endpoint"
            : `Base URL for ${providerDefinition.displayName} (leave blank to use default)`,
        default: persistedBaseUrl ?? providerDefinition.defaultBaseUrl ?? "",
      }))
    ).trim();

    if (!baseUrl && (providerDefinition.baseUrlRequired || provider === "custom-openai")) {
      console.error(
        chalk.red("✗ Login failed:") + ` ${providerDefinition.displayName} requires a base URL.`,
      );
      process.exit(1);
    }
  }

  const result = saveApiKey(provider, apiKey);
  if (baseUrl) {
    setPersistedProviderBaseUrl(provider, baseUrl);
  }

  logSavedBackend(provider, result.backend, result.warning);
}

function runEnvironmentLogin(provider: ProviderId): void {
  const definition = getProviderDefinition(provider);
  const variables = definition.environmentVariables ?? definition.apiKeyEnvNames ?? [];
  const configured = variables.filter((name) => process.env[name]?.trim());
  const missing = variables.filter((name) => !process.env[name]?.trim());

  console.log(chalk.cyan(`\n${definition.displayName} uses environment-based authentication.`));
  if (variables.length > 0) {
    console.log(chalk.dim(`  Required variables: ${variables.join(", ")}`));
  }
  if (configured.length > 0) {
    console.log(chalk.green(`  Configured: ${configured.join(", ")}`));
  }
  if (missing.length > 0) {
    console.log(chalk.yellow(`  Missing: ${missing.join(", ")}`));
  }
  if (definition.baseUrlRequired) {
    console.log(
      chalk.dim("  Pass --base-url when the provider endpoint is not discoverable automatically."),
    );
  }
}

function logSavedBackend(provider: ProviderId, backend: string, warning?: string): void {
  const backendLabel: Record<string, string> = {
    keychain: "macOS Keychain",
    "secret-tool": "GNOME Keyring (secret-tool)",
    dpapi: "Windows Credential Manager (DPAPI)",
    file: "provider-scoped file in ~/.flixa/",
  };
  const label = backendLabel[backend] ?? backend;
  console.log(
    "\n" +
      chalk.green("✓ Login successful!") +
      chalk.dim(`  ${getProviderDefinition(provider).displayName} saved to: ${label}`),
  );
  if (warning) {
    console.log(chalk.yellow("  ⚠ " + warning));
  }
}
