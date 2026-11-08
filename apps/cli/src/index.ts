#!/usr/bin/env node
import { Command } from "commander";
import { registerLoginCommand } from "./commands/login.ts";
import { registerClaudeCodeCommand } from "./commands/claude-code.ts";
import { registerCodexCommand } from "./commands/codex.ts";
import { registerShipCommand } from "./commands/ship.ts";
import { registerShareCommand } from "./commands/share.ts";
import { registerChatCommand } from "./commands/chat.ts";
import { registerModelCommand } from "./commands/model.ts";
import { registerUsageCommand } from "./commands/usage.ts";
import { registerProvidersCommand } from "./commands/providers.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { warnIfElevated } from "./security/privileges.ts";
import { CLI_VERSION } from "./version.ts";

const quietFlags = ["-h", "--help", "-V", "--version"];
if (!process.argv.slice(2).some((arg) => quietFlags.includes(arg))) {
  warnIfElevated();
}

const program = new Command();

program.name("flixa").description("Flixa CLI").showHelpAfterError().version(CLI_VERSION);

registerChatCommand(program);
registerLoginCommand(program);
registerModelCommand(program);
registerUsageCommand(program);
registerProvidersCommand(program);
registerDoctorCommand(program);
registerClaudeCodeCommand(program);
registerCodexCommand(program);
registerShipCommand(program);
registerShareCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
