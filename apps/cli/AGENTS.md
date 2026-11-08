# AGENTS.md

This file provides guidance to coding agents when working with this repository.

## Commands

- `pnpm install` — install dependencies
- `pnpm run dev` — run the CLI directly from `src/index.ts` via tsx
- `pnpm run build` — bundle to `dist/` and prepare the published package
- `pnpm run lint` — run oxlint over CLI, scripts, and OpenClaw integration sources
- `pnpm run format:check` — verify oxfmt formatting
- `pnpm run check` — typecheck, lint, format check, build, and integration smoke
- No test runner is configured; do not claim tests passed unless you ran some other concrete verification
- Useful targeted checks:
  - `pnpm run dev --help`
  - `pnpm run dev <command> --help`

## Architecture

- `src/index.ts` is the CLI entrypoint and registers commands from `src/commands/*.ts`.
- Main state is local-only:
  - config in `~/.flixa/config.json`
  - credentials via `src/auth/` with OS-specific secure storage and `~/.flixa/` fallbacks
  - chat/session persistence in `src/sessions/store.ts`
- Provider resolution is shared through `src/providers/registry.ts` and `src/providers/runtime.ts`; adding or changing a provider usually requires touching both registry/defaults and command/runtime behavior.
- Instruction files loaded into chat sessions are assembled by `src/instructions/files.ts` from parent directories, in order: `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`.

## Repo-specific gotchas

- `flixa` provider uses browser device auth; other providers are BYOK API-key flows. `custom-openai` requires a base URL.
- `login` also sets the default provider in local config.
- `logout` only removes saved credentials; it does **not** revert Claude Code settings.
- `claude-code` modifies `~/.claude.json` and `~/.claude/settings.json`, prompts before replacing values, creates `*.bak` backups, and supports only `flixa` and `anthropic`.
- When changing terminal UI/interaction patterns, check `copy-this-code-and-it/` first and keep behavior aligned unless a simpler repo architecture forces a small explicit deviation.

## UI And Interaction Parity

- When implementing or changing terminal UI, interaction patterns, mode toggles, footer behavior, autocomplete behavior, or status messaging that already exists in `copy-this-code-and-it/`, inspect the corresponding implementation there first.
- Prefer matching `copy-this-code-and-it/` behavior and information density before inventing a new pattern.
- If behavior must differ because this repository has a simpler architecture, keep the deviation explicit and minimal.
