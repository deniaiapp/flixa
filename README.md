# Flixa

AI-powered code implementation assistant for VS Code.

## Showcase

### Try: Agent Mode

Rest assured, you can take a break safely.

![Agent mode demo](assets/agent_mode.gif)

### Inline editing

![Inline editing demo](assets/inline_editing.png)

## Features

- AI chat interface in sidebar
- Inline code editing with `Ctrl+I` / `Cmd+I`
- Agent mode with shell command execution
- Safety agent mode (Auto Approve)
- Diff preview and apply
- Auto context (file list, git status, package.json, tsconfig.json)
- Multiple AI model support (OpenAI, Anthropic, Google, etc.)

## Zed

The `zed/` directory contains the Flixa ACP integration for Zed's Agent Panel. See [zed/README.md](zed/README.md) for build and configuration instructions.
The ACP Registry submission metadata is in `acp-registry/flixa/`.

## Publishing

Set `VSCE_PAT` to your [VS Code Marketplace token](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) and `OVSX_PAT` to your [Open VSX token](https://open-vsx.org/user-settings/tokens). The `deniai` namespace must already exist in Open VSX.

```sh
bun run publish
```

This builds and packages `flixa.vsix` once, then publishes the same file to both registries in parallel. Both publishing commands finish even if one fails, and any failure returns a nonzero exit code.

To retry a failed upload using the existing package:

```sh
bun run publish:vscode
bun run publish:openvsx
```

## License

MIT
