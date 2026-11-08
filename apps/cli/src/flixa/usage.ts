import { getRemainingPercent, getUsageSummary, type UsageSummary } from "@deniai/flixa-api-client";
import type { DeniUsageInfo } from "./api.ts";

export function formatUsageReport(usage: DeniUsageInfo): string {
  const lines = [
    "Usage",
    `  Tier: ${usage.tier}`,
    `  Plan ID: ${usage.planId ?? "-"}`,
    `  Status: ${usage.status ?? "-"}`,
    `  Team: ${usage.isTeam ? "yes" : "no"}`,
    `  Billing period end: ${usage.periodEnd ?? "-"}`,
    `  Max mode: ${formatMaxMode(usage)}`,
  ];

  // Usage is not split by model class: Flixa, Deni AI chat, and Deni Run share one
  // monthly pool (reported as `pool`; older servers only send per-category items).
  const pool = getUsageSummary(usage);
  if (!pool) {
    lines.push("", "No usage returned.");
    return lines.join("\n");
  }

  lines.push("", ...formatPool(pool));
  return lines.join("\n");
}

function formatPool(pool: UsageSummary): string[] {
  const left = getRemainingPercent(pool);
  if (left === null) {
    return ["Monthly usage", "  unlimited"];
  }
  return [
    "Monthly usage (shared with Deni AI chat and Deni Run)",
    `  used: ${(100 - left).toFixed(1)}%`,
    `  left: ${left.toFixed(1)}%`,
    `  resets: ${pool.periodEnd ?? "-"}`,
  ];
}

function formatMaxMode(usage: DeniUsageInfo): string {
  if (usage.maxModeEnabled) {
    return "enabled";
  }

  if (usage.maxModeEligible) {
    return "eligible";
  }

  return "disabled";
}
