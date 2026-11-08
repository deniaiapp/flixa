# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install              # Install dependencies
pnpm run dev              # Run CLI directly from TypeScript via tsx (no build needed)
pnpm run build            # Bundle to dist/ with esbuild (required before npm publish)
```

No test runner is configured.

## Publishing

- `main` branch push → canary release (`{version}-canary.{run_number}`) via GitHub Actions
- `v*` tag push → stable release via GitHub Actions
- Uses npm trusted publishing (OIDC provenance, no `NPM_TOKEN` secret needed)

## Architecture

The CLI is built with **commander** and structured as: `src/index.ts` registers commands → `src/commands/*.ts` implement each command → `src/auth/` handles credential storage.

**Auth flow (`src/auth/service.ts`):**
Device auth against `https://deniai.app/api/device-auth` — POST `{action: "initiate"}` to get a `deviceCode`/`userCode`, then poll with `{action: "poll", deviceCode}` every 5s until `approved: true` returns an `apiKey`.

**Credential storage (`src/auth/keychain.ts`):**
Platform-specific with fallback chain:
- macOS → `security` CLI (Keychain)
- Linux → `secret-tool` (libsecret), falls back to `~/.flixa/credentials`
- Windows → DPAPI via PowerShell temp script (secret never passed as CLI arg), falls back to `~/.flixa/credentials`

**`claude-code` command (`src/commands/claude-code.ts`):**
Writes the stored API key into `~/.claude.json` (`primaryApiKey`) and `~/.claude/settings.json` (`env.ANTHROPIC_API_KEY`, `env.ANTHROPIC_BASE_URL → https://flixa-api.deniai.app/`) to redirect Claude Code to the Flixa proxy backend. Prompts for confirmation before overwriting existing values.
