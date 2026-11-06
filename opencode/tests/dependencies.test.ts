import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esm from "glob";

const require = createRequire(import.meta.url);
for (const [format, { glob, globSync }] of [["esm", esm], ["cjs", require("glob")]] as const) {
  test(`glob ${format} honors cancellation before filesystem access and preserves matching`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fossa-glob-"));
    try {
      writeFileSync(join(cwd, "fixture.ts"), "");
      expect(await glob("*.ts", { cwd })).toEqual(["fixture.ts"]);
      const reason = new Error("cancelled fixture");
      const signal = AbortSignal.abort(reason);
      const fail = () => { throw new Error("unexpected filesystem access"); };
      const fs = { readdir: fail, readdirSync: fail, lstat: fail, lstatSync: fail, realpath: fail, realpathSync: fail };
      await expect(glob("**/*", { cwd, signal, fs })).rejects.toThrow(reason);
      expect(() => globSync("**/*", { cwd, signal, fs })).toThrow(reason);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
