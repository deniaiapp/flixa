# Flixa for Zed

This directory contains Flixa's Agent Client Protocol (ACP) integration for Zed. It connects Zed's Agent Panel to the Flixa agent API and supports workspace context, file tools, terminal commands, approval modes, model selection, context compaction, and Deni AI device login.

## Build

```sh
cd zed
bun install
bun run typecheck
bun run build
```

## Configure Zed

Add an external agent to Zed's settings. Replace the path with the absolute path to this repository.

```json
{
  "agent_servers": {
    "Flixa": {
      "type": "custom",
      "command": "bun",
      "args": ["run", "<your-path>/deni-ai-code/zed/dist/flixa-zed.js"],
      "env": {}
    }
  }
}
```

The agent can use `FLIXA_API_KEY` or `DENI_API_KEY`. If neither variable is set, choose the Flixa login method when Zed requests authentication. The device key is stored in the platform Flixa configuration directory.

Supported environment variables are `FLIXA_MODEL`, `FLIXA_REASONING_EFFORT`, `FLIXA_APPROVAL_MODE`, `FLIXA_COMPACT_TOKEN_THRESHOLD`, and `FLIXA_MAX_AGENT_ITERATIONS`.

The ACP agent supports `/help`, `/clear`, `/compact`, `/stop`, `/agent`, `/chat`, `/model`, and `/approval`.

## Publish

The ACP Registry entry is prepared in `acp-registry/flixa/`. Publish the package from this directory after signing in to npm:

```sh
cd zed
bun publish --access public
```

The registry submission uses the published package version and is ready to copy into the ACP Registry repository.
