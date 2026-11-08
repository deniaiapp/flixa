# Flixa for Zed

This directory contains Flixa's Agent Client Protocol (ACP) integration for Zed. It connects Zed's Agent Panel to the Flixa agent API and supports workspace context, file tools, terminal commands, approval modes, model selection, context compaction, and Deni AI device login.

## Build

```sh
pnpm install
pnpm --filter @deniai/flixa-zed run typecheck
pnpm --filter @deniai/flixa-zed run build
```

## Configure Zed

Add an external agent to Zed's settings. Replace the path with the absolute path to this repository.

```json
{
  "agent_servers": {
    "Flixa": {
      "type": "custom",
      "command": "node",
      "args": ["<your-path>/flixa/apps/zed/dist/flixa-zed.js"],
      "env": {}
    }
  }
}
```

The agent can use `FLIXA_API_KEY` or `DENI_API_KEY`. If neither variable is set, choose the Flixa login method when Zed requests authentication. The device key is stored in the platform Flixa configuration directory.

Supported environment variables are `FLIXA_MODEL`, `FLIXA_REASONING_EFFORT`, `FLIXA_APPROVAL_MODE`, `FLIXA_COMPACT_TOKEN_THRESHOLD`, and `FLIXA_MAX_AGENT_ITERATIONS`.

The ACP agent supports `/help`, `/clear`, `/compact`, `/stop`, `/agent`, `/chat`, `/model`, and `/approval`.

Tools, approval modes, and the agent loop come from `@deniai/flixa-core` (`packages/core`), shared with the CLI and the VS Code extension. The agent offers `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `LS`, and `Delete` on the core Node host (Grep and Glob use `rg` from `PATH` when it is installed, else a built-in search). Approval modes: `all` runs everything, `auto` sends shell commands to an AI safety review, `safe` asks before shell commands, and `manual` asks before every tool call; commands on the shared block list never run. Compaction is local: when the context reaches `FLIXA_COMPACT_TOKEN_THRESHOLD`, the model summarizes the conversation, so it works with every model. Sessions saved with the old tool names (`read_file`, `edit_file`, `run_terminal_cmd`, …) are mapped to the new names when they are loaded.

## Publish

The ACP Registry entry is prepared in `acp-registry/flixa/` (inside `apps/zed`). Releases are published by the `Release Zed agent` workflow when a `zed-v*` tag is pushed.

The registry submission uses the published package version and is ready to copy into the ACP Registry repository.
