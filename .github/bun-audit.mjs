import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function auditResult(output, status) {
  const result = JSON.parse(output);
  if (result.manifestUnavailable?.length || ![0, 1].includes(status) || result.dryRun !== false || !Number.isSafeInteger(result.fixed) || result.fixed < 0 || !Number.isSafeInteger(result.remaining) || result.remaining < 0 || !Array.isArray(result.fixes) || (result.fixed > 0 && !result.fixes.length)) throw new Error("invalid security audit result");
  return { changed: result.fixed > 0, fixed: result.fixed, remaining: result.remaining };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const run = spawnSync("bun", ["audit", "fix", "--json", "--ignore-scripts"], { cwd: process.argv[2] || ".", encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (run.error || run.signal) throw run.error || new Error("security audit interrupted");
  const result = auditResult(run.stdout, run.status);
  console.log(`fixed ${result.fixed} advisories; ${result.remaining} remain for review`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
}
