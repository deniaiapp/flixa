import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// Newer openclaw releases no longer ship type declarations for openclaw/plugin-sdk/cli-backend;
// derive the backend type from the plugin API instead.
type CliBackendPlugin = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];

const DEFAULT_MODEL_REF = "flixa/openai/gpt-6-luna";

function buildFlixaBackend(): CliBackendPlugin {
  return {
    id: "flixa",
    liveTest: {
      defaultModelRef: DEFAULT_MODEL_REF,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    config: {
      command: "flixa",
      args: ["ship", "--json", "--provider", "flixa"],
      output: "json",
      input: "arg",
      maxPromptArgChars: 8_000,
      modelArg: "--model",
      sessionMode: "none",
      serialize: true,
    },
  };
}

export default definePluginEntry({
  id: "flixa",
  name: "Flixa Ship",
  description: "Run Flixa's guarded coding agent through OpenClaw.",
  register(api) {
    api.registerCliBackend(buildFlixaBackend());
  },
});
