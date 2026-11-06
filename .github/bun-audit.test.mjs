import { test } from "node:test";
import assert from "node:assert/strict";
import { auditResult } from "./bun-audit.mjs";

const report = { dryRun: false, fixed: 1, remaining: 2, fixes: [{ name: "nth-check", from: "2.0.0", to: "2.0.1" }] };
test("native partial fix can publish while incompatible upgrades remain for review", () => {
  assert.deepEqual(auditResult(JSON.stringify(report), 1), { changed: true, fixed: 1, remaining: 2 });
});
test("blocked upgrades and clean audits never open empty prs", () => {
  for (const remaining of [0, 2]) assert.equal(auditResult(JSON.stringify({ ...report, fixed: 0, remaining, fixes: [] }), remaining ? 1 : 0).changed, false);
});
test("network errors, dry runs and malformed reports cannot publish fixes", () => {
  for (const output of ["", "<html>bad gateway</html>", '{}', JSON.stringify({ ...report, manifestUnavailable: ["registry unavailable"] }), JSON.stringify({ ...report, dryRun: true }), JSON.stringify({ ...report, fixed: -1 }), JSON.stringify({ ...report, fixes: [] })]) assert.throws(() => auditResult(output, 1));
  assert.throws(() => auditResult(JSON.stringify(report), 2));
});
