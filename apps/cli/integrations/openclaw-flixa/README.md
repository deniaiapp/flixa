# @deniai/openclaw-flixa

Run Flixa Ship from OpenClaw channels through OpenClaw's CLI backend plugin
surface. The plugin version intentionally follows the Flixa CLI version.

This is the one-day integration path: OpenClaw owns the Gateway, channels,
pairing, and conversation UX; Flixa owns repository inspection, edits,
verification, permissions, sessions, and Ship Cards.

## Prerequisites

- OpenClaw `>=2026.5.17`
- Flixa installed and available as `flixa` on `PATH`
- Flixa authentication configured on the Gateway host:

```sh
flixa login
```

## Local development

```sh
pnpm install
pnpm run build
node -e "import('./dist/index.js').then(() => console.log('Flixa OpenClaw plugin loaded.'))"
```

`pnpm run build` synchronizes the plugin version from the repository root. Set
`FLIXA_RELEASE_VERSION` in a release job when publishing a canary or stable
plugin artifact.

Once installed into an OpenClaw instance, inspect the loaded backend with:

```sh
openclaw plugins inspect flixa --runtime --json
```

For a local checkout, install the plugin package from this directory using
OpenClaw's local plugin install flow. The backend appears as the model ref:

```text
flixa/openai/gpt-5.6-sol
```

Then send a normal OpenClaw message such as:

```text
Ship this task in the current repo: fix the login retry bug and run the tests.
```

OpenClaw launches:

```sh
flixa ship --json --provider flixa --model <model> <prompt>
```

The JSON result contains the final response, verification evidence, session id,
and optional Share Card data. Keep remote sessions paired and do not enable
Flixa `--yolo` for untrusted channels.

## Publish

```sh
pnpm pack
openclaw plugins install npm-pack:<generated-tarball>
```

After the first public release, publish the package to npm/ClawHub and install
it with:

```sh
openclaw plugins install clawhub:@deniai/openclaw-flixa
```

ClawHub publishing requires a `CLAWHUB_TOKEN` repository secret. The release
workflow publishes both the npm artifact and the ClawHub `code-plugin` artifact
with the same version.
