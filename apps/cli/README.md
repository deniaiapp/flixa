# Flixa CLI

AI coding assistant CLI.

## Install

```sh
npm install -g @deniai/flixa
```

or

```sh
pnpm install -g @deniai/flixa
```

## Quick start

```sh
flixa login
flixa chat
```

## Commands

### Login

Log in to Flixa or save a BYOK API key for another provider.

```sh
flixa login
flixa login --provider anthropic
flixa login --provider openai
flixa login --provider custom-openai --base-url http://localhost:1234/v1
```

Flixa includes the built-in providers above plus the provider catalog from
`models.dev` (OpenAI-compatible gateways, Anthropic-compatible endpoints, and
other catalogued providers). Inspect the available catalog with:

Built-ins: `flixa`, `openai`, `anthropic`, `google`, `openrouter`, and
`custom-openai`.

```sh
flixa providers list
```

The bundled catalog can be refreshed during development with:

```sh
pnpm run providers:update
```

Providers with an OpenAI-compatible endpoint use the shared agent runtime;
providers that require native cloud credentials show the required environment
variables and must be configured outside Flixa.

Notes:

- `flixa` uses browser-based device auth.
- Other providers use an API key prompt.
- `custom-openai` requires `--base-url` or an entered base URL.
- Logging in also sets the selected provider as the default provider.

### Logout

Remove stored credentials for a provider.

```sh
flixa logout
flixa logout --provider anthropic
```

This removes saved credentials only. It does **not** undo Claude Code configuration changes.

### Provider management

Inspect configured providers and switch the default provider.

```sh
flixa providers list
flixa providers current
flixa providers set-default anthropic
```

### Model selection

Set the default model for the current or specified provider.

```sh
flixa model
flixa model --provider anthropic
flixa model claude-sonnet-4-0 --provider anthropic
flixa model gpt-4.1 --provider openai
```

For providers with configurable endpoints, you can also pass `--base-url`.

### Chat

Start the interactive chat interface.

```sh
flixa chat
flixa chat --provider anthropic
```

Inside chat:

- `/compact [focus]` summarizes the conversation to free up context. Long
  conversations are also compacted automatically once they pass about 240,000
  characters; set `FLIXA_AUTO_COMPACT_CHARS` to change the limit (`0` disables it).
- Custom slash commands are Markdown files in `.claude/commands/` or
  `.flixa/commands/` (project) and the same folders under your home directory.
  `review.md` becomes `/review`, `frontend/lint.md` becomes `/frontend:lint`.
  Use `$ARGUMENTS` or `$1`..`$9` for arguments and an optional `description:` /
  `argument-hint:` frontmatter. Built-in commands are never overridden.
- The agent can keep a task list (`TodoWrite`) and read public web pages
  (`WebFetch`, asks for approval, blocks private and local addresses).
- `@path/to/file` attaches a file (or a directory listing) to your prompt. Press
  Tab to complete paths. Only files inside the workspace are attached.
- `# note` saves a note to `AGENTS.md` (or `CLAUDE.md` if that is the file you
  have). `/memory user <note>` saves a personal note to `~/.flixa/AGENTS.md`.
- `/rewind [turns|list]` undoes the agent's file edits for the last turns
  (files only, the conversation stays). `/export [path]` saves the conversation
  as Markdown. `/doctor` checks your setup (also `flixa doctor`).
- The agent can start background commands (`Bash` with `run_in_background`, then
  `BashOutput` / `KillShell`), delegate work to sub-agents (`Task`), and load
  skills (`Skill`).
- `/agents`, `/skills`, `/permissions` and `/hooks` show what is configured.

#### Sub-agents and skills

- Sub-agents are Markdown files in `.claude/agents/` or `.flixa/agents/` with
  `description:` (required), `tools:` and `model:` frontmatter; the body is the
  system prompt. `general-purpose` and read-only `explore` are built in.
  Sub-agents cannot start other sub-agents.
- Skills are `.claude/skills/<name>/SKILL.md` or `.flixa/skills/<name>/SKILL.md`
  with a `description:`. Only names and descriptions go into the prompt; the
  agent loads the full text on demand.

#### Permission rules and hooks

Put them in `settings.json` (`~/.flixa/`, `~/.claude/`, or a project's
`.claude/` / `.flixa/`, plus `settings.local.json`):

```json
{
  "permissions": {
    "allow": ["Bash(pnpm test:*)", "Read(src/**)", "WebFetch(domain:docs.example.com)"],
    "ask": ["Write(docs/**)"],
    "deny": ["Read(.env)", "Bash(git push:*)"]
  },
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "pnpm run format" }] }
    ]
  }
}
```

`deny` beats `ask`, and `ask` beats `allow`. A compound command such as
`pnpm test && curl ...` is allowed only if every part is allowed. Rules for
`Read`/`Write`/`Edit`/`Grep`/`Glob` apply to those tools only; they do not stop a
shell command from reading the same file.

Hooks run `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop` commands with
a JSON payload on stdin. Exit code 2 blocks the action and sends stderr back.

A cloned repository must not be able to run code or pre-approve commands just by
being opened, so:

- Hooks load only from your user-level settings. Set `FLIXA_TRUST_PROJECT_HOOKS=1`
  to also load project hooks.
- Project-level `deny` and `ask` rules always apply, but project-level `allow`
  rules are ignored unless `FLIXA_TRUST_PROJECT_SETTINGS=1`.

Run once without the interactive UI. Only the final answer goes to stdout, and
tool progress goes to stderr, so the output is safe to pipe. Tools that need
approval are denied unless you pass `--yolo`, `--auto`, or `--accept-edits`.

```sh
flixa --print "Summarize the last commit"
git diff | flixa --print "Review this diff"
flixa --print "/review src/index.ts"
```

### Ship mode

Run a complete coding mission from one prompt. Ship mode inspects the repo,
implements the focused change, verifies it, and can produce a redacted Markdown
card you can paste into a PR or share online.

```sh
flixa ship "Add a retry budget to the API client" --share
flixa ship "Fix the failing login flow" --verify "pnpm run build" --share .flixa/ship-card.md
flixa ship "Plan a migration to SQLite" --plan
```

Pass a GitHub Issue URL to fetch its title, body, labels, and canonical URL
before starting the Ship run. The Issue text is treated as untrusted task
context, and the share card shows only the title and URL instead of copying the
full Issue body:

```sh
flixa ship https://github.com/org/repo/issues/123
```

To publish a card, opt in explicitly with `--share-url`. This creates an
unlisted Flixa Share URL containing the redacted card metadata, changed-file
list, diff stat, verification result, model, and final summary; it does not
publish repository source:

```sh
flixa ship "Fix the failing login flow" --share-url
flixa share --share-url
```

The default endpoint is `https://share.flixa.engineer/api/cards`. Set
`FLIXA_SHARE_ENDPOINT` to point at a local or self-hosted Share service during
development.

The generated card includes a `Try this task with Flixa` command using the
canary package so someone viewing the card can reproduce the task quickly.

By default, Ship uses guarded auto mode: file edits and shell commands are
reviewed for safety, while deterministic destructive commands are blocked.
Use `--interactive` for an approval prompt on every edit/command or `--yolo`
only when you explicitly want to bypass those checks.

Create a card from the latest saved session at any time:

```sh
flixa share
flixa share --output .flixa/latest-card.md
```

When a card is generated, its Markdown source is copied to the system
clipboard automatically and the terminal renders a rich preview. If the
platform has no clipboard utility, the preview still works and the command
reports that copying was unavailable.

### OpenClaw integration

The first OpenClaw integration is available under
`integrations/openclaw-flixa`. It registers Flixa as an OpenClaw CLI backend,
so OpenClaw owns channels, pairing, and Gateway sessions while Flixa owns the
coding loop and permissions.

```sh
cd integrations/openclaw-flixa
npm install
npm run build
```

### Claude Code integration

Configure Claude Code to use Flixa or Anthropic credentials.

```sh
flixa claude-code
flixa claude-code --provider flixa
flixa claude-code --provider anthropic
```

What this changes:

- `~/.claude.json`
  - `hasCompletedOnboarding`
  - `primaryApiKey`
- `~/.claude/settings.json`
  - `env.ANTHROPIC_API_KEY`
  - `env.ANTHROPIC_BASE_URL` when supported by the provider

Safety features:

- Prompts before replacing existing values
- `--dry-run` shows planned changes without writing files
- Creates `*.bak` backups before writing changed Claude settings files
- Stops with an error if an existing Claude JSON file is invalid instead of overwriting it

Supported providers for `claude-code`:

- `flixa`
- `anthropic`

### Usage

Show account usage information.

```sh
flixa usage
```

### Codex

Run the Codex-related command flow.

```sh
flixa codex
```

## Configuration and storage

Flixa stores local config in:

- `~/.flixa/config.json`

This includes things like:

- default provider
- provider-specific base URLs
- provider-specific default models

Credentials are stored per provider using the best available backend for your OS:

- macOS: Keychain via `security`
- Linux: `secret-tool` when available, otherwise plaintext fallback in `~/.flixa/`
- Windows: DPAPI-backed local encrypted file

Fallback credential files may include:

- `~/.flixa/credentials`
- `~/.flixa/credentials-<provider>`

Claude Code integration writes to:

- `~/.claude.json`
- `~/.claude/settings.json`

## Troubleshooting

### Linux: `secret-tool` not installed

If `secret-tool` is unavailable, Flixa falls back to a file in `~/.flixa/` with best-effort restricted permissions and prints a warning.

### Already logged in

If a provider already has saved credentials, run:

```sh
flixa logout --provider <provider>
```

Then log in again.

### Claude Code still points to the old provider

`flixa logout` does not modify Claude Code config files. Re-run:

```sh
flixa claude-code --provider <provider>
```

### Custom OpenAI-compatible endpoint

Use:

```sh
flixa login --provider custom-openai --base-url http://your-endpoint/v1
```

## Development

```sh
pnpm install
pnpm run dev
pnpm run build
pnpm run check
pnpm run lint
pnpm run format
```
