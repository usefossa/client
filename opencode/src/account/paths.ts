import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export function walletDirectory(home = homedir(), platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists = existsSync) {
  const path = platform === "win32" ? win32 : posix;
  const legacy = path.join(home, ".local", "share", "fossa-opencode");
  // keep existing wallets, encryption keys and pending journals together.
  if (["wallets.sqlite", "device.key"].some(file => exists(path.join(legacy, file)))) return legacy;
  const absolute = (value?: string) => value && path.isAbsolute(value) ? value : undefined;
  const base = absolute(env.XDG_DATA_HOME) ?? (platform === "win32"
    ? absolute(env.LOCALAPPDATA) ?? path.join(home, "AppData", "Local")
    : platform === "darwin" ? path.join(home, "Library", "Application Support") : path.join(home, ".local", "share"));
  return path.join(base, "fossa-opencode");
}
