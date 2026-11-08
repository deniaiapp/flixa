import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";

const DEFAULT_MODEL_REF = "flixa/openai/gpt-5.6-sol";

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
