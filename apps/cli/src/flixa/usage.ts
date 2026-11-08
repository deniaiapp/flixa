import type { DeniUsageInfo, DeniUsageBucket } from "./api.ts";

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
  // monthly pool. Every bucket reports it (older servers split it; then "basic" stands for it).
  const pool = usage.usage.find((bucket) => bucket.category === "basic") ?? usage.usage[0];
  if (!pool) {
    lines.push("", "No usage returned.");
    return lines.join("\n");
  }

  lines.push("", ...formatPool(pool));
  return lines.join("\n");
}

function formatPool(bucket: DeniUsageBucket): string[] {
  if (bucket.limit === null || bucket.limit <= 0 || bucket.remaining === null) {
    return ["Monthly usage", "  unlimited"];
  }
  const left = Math.max(0, Math.min(100, (bucket.remaining / bucket.limit) * 100));
  return [
    "Monthly usage (shared with Deni AI chat and Deni Run)",
    `  used: ${(100 - left).toFixed(1)}%`,
    `  left: ${left.toFixed(1)}%`,
    `  resets: ${bucket.periodEnd ?? "-"}`,
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
