import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { walletDirectory } from "../src/account/paths";

const missing = () => false;
const cases: [NodeJS.Platform, string, NodeJS.ProcessEnv, string][] = [
  ["linux", "/home/alice", {}, "/home/alice/.local/share/fossa-opencode"],
  ["linux", "/home/alice", { XDG_DATA_HOME: "/data/alice" }, "/data/alice/fossa-opencode"],
  ["linux", "/home/alice", { XDG_DATA_HOME: "relative" }, "/home/alice/.local/share/fossa-opencode"],
  ["linux", "/home/alice", { XDG_DATA_HOME: "" }, "/home/alice/.local/share/fossa-opencode"],
  ["darwin", "/Users/alice", {}, "/Users/alice/Library/Application Support/fossa-opencode"],
  ["darwin", "/Users/alice", { XDG_DATA_HOME: "/data/alice" }, "/data/alice/fossa-opencode"],
  ["win32", "C:\\Users\\Alice", {}, "C:\\Users\\Alice\\AppData\\Local\\fossa-opencode"],
  ["win32", "C:\\Users\\Alice", { LOCALAPPDATA: "D:\\User Data" }, "D:\\User Data\\fossa-opencode"],
  ["win32", "C:\\Users\\Alice", { LOCALAPPDATA: "relative" }, "C:\\Users\\Alice\\AppData\\Local\\fossa-opencode"],
  ["win32", "C:\\Users\\Alice", { XDG_DATA_HOME: "D:\\Data" }, "D:\\Data\\fossa-opencode"],
  ["win32", "C:\\Users\\Alice", { XDG_DATA_HOME: "\\\\server\\alice" }, "\\\\server\\alice\\fossa-opencode"],
];
for (const [platform, home, env, expected] of cases) test(`${platform} wallet directory: ${JSON.stringify(env)}`, () => {
  expect(walletDirectory(home, platform, env, missing)).toBe(expected);
});

for (const platform of ["linux", "darwin", "win32"] as const) for (const file of ["wallets.sqlite", "device.key"]) test(`${platform} preserves existing ${file} location`, () => {
  const path = platform === "win32" ? win32 : posix, home = platform === "win32" ? "C:\\Users\\Alice" : "/users/alice";
  const legacy = path.join(home, ".local", "share", "fossa-opencode");
  expect(walletDirectory(home, platform, {}, candidate => candidate === path.join(legacy, file))).toBe(legacy);
});

for (const override of [false, true]) test(`default store opens and reopens with XDG override ${override}`, () => {
  const directory = mkdtempSync(join(tmpdir(), "fossa-paths-")), data = override ? join(directory, "User Data") : "";
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, LOCALAPPDATA: join(directory, "AppData", "Local"), XDG_DATA_HOME: data };
  try {
    const result = Bun.spawnSync([process.execPath, "-e", `
      import { Store } from ${JSON.stringify(join(import.meta.dir, "../src/account/store.ts"))};
      let store = new Store();
      store.put({ id: "fixture", wallet: "synthetic", stage: "uncertain", transaction: "recovery", created: 1 });
      store.close();
      store = new Store();
      if (store.request("fixture", "synthetic")?.transaction !== "recovery") throw Error("Journal lost");
      store.close();
    `], { env });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(walletDirectory(directory, process.platform, env), "wallets.sqlite"))).toBe(true);
    if (override) expect(existsSync(join(directory, ".local"))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
