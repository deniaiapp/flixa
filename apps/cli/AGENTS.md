# AGENTS.md

This file provides guidance to coding agents when working with this repository.

## Commands

- `pnpm install` — install dependencies
- `pnpm run dev` — run the CLI directly from `src/index.ts` via tsx
- `pnpm run build` — bundle to `dist/` and prepare the published package
- `pnpm run lint` — run oxlint over CLI sources and scripts (the OpenClaw plugin lives in `apps/openclaw-flixa`)
- `pnpm run format:check` — verify oxfmt formatting
- `pnpm run check` — typecheck, lint, format check, regression checks, the agent e2e check, build, and OpenClaw integration contract check
- No unit test runner is configured. `pnpm test` runs `scripts/verify-cli-regressions.ts` and `scripts/verify-agent-e2e.ts` (one full tool-using turn of `flixa chat --print` against a local mock of `/v1/agent/responses`); do not claim other tests passed
- Useful targeted checks:
  - `pnpm run dev --help`
  - `pnpm run dev <command> --help`

## Architecture

- `src/index.ts` is the CLI entrypoint and registers commands from `src/commands/*.ts`.
- Main state is local-only:
  - config in `~/.flixa/config.json`
  - credentials via `src/auth/` with OS-specific secure storage and `~/.flixa/` fallbacks
  - chat/session persistence in `src/sessions/store.ts`
- Agent tools and the Flixa agent loop come from `@deniai/flixa-core` (`packages/core`): the
  core tools (Bash, Read, Write, Edit, Grep, Glob, LS) run on the core Node host, and
  `src/agent-tools/tools.ts` adds the CLI-only tools (GitStatus, GitDiff, TodoWrite, WebFetch,
  BashOutput, KillShell, Skill, Task). `src/agent-tools/runner.ts` runs Flixa turns through the
  core `runAgentLoop`; its CLI modes (default, accept edits, auto, yolo, plan) map to shared
  approval policies in `getCliApprovalPolicy`. BYOK providers still use the AI SDK loop in
  `src/providers/runtime.ts` with the same tools.
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
