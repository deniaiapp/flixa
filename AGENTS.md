# Agent guide for the Flixa monorepo

Flixa clients for the Deni AI / Flixa API: a CLI, a VS Code extension, a Zed ACP agent,
and an OpenClaw plugin. pnpm workspace, Node.js 26+, TypeScript 7, oxlint, oxfmt,
vitest, esbuild.

## Layout

| Path                     | Package                              | Notes                                                                             |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------------------- |
| `apps/cli`               | `@deniai/flixa` (npm)                | Ink/commander CLI. See `apps/cli/AGENTS.md`.                                      |
| `apps/vscode`            | `flixa` (Marketplace / Open VSX)     | Extension (CommonJS esbuild bundle). See `apps/vscode/AGENTS.md`.                 |
| `apps/vscode/webview-ui` | `flixa-webview-ui` (private)         | React 19 + Vite + Tailwind 4 chat UI, built into `webview-ui/build` for the VSIX. |
| `apps/zed`               | `@deniai/flixa-zed` (npm)            | ACP agent for Zed. ACP Registry metadata lives in `apps/zed/acp-registry/`.       |
| `apps/openclaw-flixa`    | `@deniai/openclaw-flixa` (npm)       | OpenClaw CLI backend; its version follows `apps/cli/package.json`.                |
| `packages/api-client`    | `@deniai/flixa-api-client` (private) | Shared API client. Consumed as TypeScript source and bundled into each app.       |
| `packages/core`          | `@deniai/flixa-core` (private)       | Shared agent tools, tool hosts, approval policy, and agent loop. Bundled too.     |
| `skills/flixa-ship`      | ClawHub skill                        | Published together with the CLI.                                                  |

The webview UI stays nested under `apps/vscode` because the extension loads
`webview-ui/build` relative to its own root and `vsce` packages only that directory.

## Commands

Run from the repository root:

- `pnpm install` — one lockfile for the whole workspace (`pnpm-lock.yaml`).
- `pnpm run typecheck | lint | test | build` — fan out to every package that has the script.
- `pnpm run format` / `pnpm run format:check` — oxfmt over the whole repository.
- `pnpm run check` — all of the above.
- One package: `pnpm --filter <name> run <script>` (for example
  `pnpm --filter @deniai/flixa run check`, `pnpm --filter flixa run compile`).

`apps/cli` has no unit tests; its `test` script runs `scripts/verify-cli-regressions.ts`.
`pnpm --filter flixa run package` builds a VSIX locally; never run the `publish*` scripts.

## Shared configuration

- `tsconfig.base.json` holds the shared strict options; each package extends it and keeps
  its own module/target settings.
- `.oxlintrc.json` and `.oxfmtrc.json` are shared. oxfmt overrides keep the existing
  style of `apps/vscode` and `apps/zed` (single quotes; tabs in the webview UI).
- `.git-blame-ignore-revs` lists the one-time formatting commit.
- Generated: `apps/cli/src/providers/models-dev.generated.ts` (`pnpm --filter @deniai/flixa run providers:update`).

## API client rules

- Base URLs (`https://deniai.app`, `https://flixa-api.deniai.app`) are defined only in
  `packages/api-client/src/urls.ts`. Overrides: `FLIXA_BASE_URL` (agent base, `…/v1/agent`)
  and `DENI_AI_BASE_URL`. Non-https URLs are refused unless loopback or
  `FLIXA_ALLOW_INSECURE_BASE_URL=1`.
- Client identification headers come from `createClientHeaders({ kind, version })`; do not
  hand-write `User-Agent` / `x-client` / `x-flixa-client` / `originator` in apps.
- Device login, usage (`/v1/deni/usage`), models (`/v1/models`), and error-envelope parsing
  live in the package. Apps own storage (CLI keychain/file, VS Code SecretStorage, Zed
  file) and UX copy.
- Apps import `@deniai/flixa-api-client` as a devDependency (`workspace:*`) and must bundle
  it: the CLI build has an esbuild plugin for this; VS Code and Zed bundle everything.
- Add vitest coverage in `packages/api-client/src/*.test.ts` (mock `fetch`) for changes.

## Decisions for later phases

- F3 (tool unification) will align agent tool names to the CLI style: `Bash`, `Read`,
  `Write`, `Edit`, `Grep`, `Glob`, and so on. Tool implementations and agent loops are
  still per app until then (F3/F4); do not merge them piecemeal.

## Releases and CI

- `.github/workflows/ci.yml` — typecheck, lint, format check, tests, builds, VSIX package
  (no publish); the CLI also runs on Windows.
- `publish-cli.yml` — CLI + OpenClaw plugin + Flixa Ship skill: canary on `main` pushes
  touching them, stable on `cli-v*` tags. npm trusted publishing must be re-pointed from
  `deniaiapp/flixa-cli` to `deniaiapp/flixa` before it works.
- `update-providers.yml` — daily models.dev refresh that bumps the CLI patch version and
  pushes a `cli-v*` tag.
- `release-vscode.yml` — `vscode-v*` tags (secrets `VSCE_PAT`, `OVSX_PAT`).
- `release-zed.yml` — `zed-v*` tags (npm trusted publishing).
- Never publish from a local machine, and never run `vsce publish`, `ovsx publish`, or
  `npm publish` by hand.

## Conventions

- Conventional commits, scoped by package where useful (`feat(cli): …`, `fix(vscode): …`).
- Keep changes scoped to the package you are working on; update the package's own
  `AGENTS.md`/README when its commands or behavior change.
- Code, identifiers, and commit messages in English.
