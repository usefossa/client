import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import { DEFAULT_API_URL, safeUrl } from "../src/api";

type Entry = { package?: string; options?: Record<string, unknown> };
export function installConfig(text: string, plugin: string, endpoint = DEFAULT_API_URL) {
  const apiUrl = safeUrl(endpoint), errors: import("jsonc-parser").ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as { plugins?: unknown[] };
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value) || value.plugins !== undefined && !Array.isArray(value.plugins)) throw Error("Existing OpenCode configuration is invalid; it was not changed.");
  const own = (item: unknown) => {
    const spec = typeof item === "string" ? item : (item as Entry | null)?.package;
    if (spec === plugin || spec === "@fossa/opencode" || spec?.startsWith("@fossa/opencode@") || spec && /^github:usefossa\/client(?:#[^:]*)?::path:opencode$/.test(spec)) return true;
    try {
      const path = spec?.startsWith("file:") ? fileURLToPath(spec) : spec;
      return !!path && isAbsolute(path) && JSON.parse(readFileSync(resolve(path, "package.json"), "utf8")).name === "@fossa/opencode";
    } catch { return false; }
  };
  const old = value.plugins?.find(own), entry = typeof old === "object" && old ? old as Entry : {};
  const plugins = (value.plugins ?? []).filter(item => !own(item));
  plugins.push({ ...entry, package: plugin, options: { ...entry.options, apiUrl } });
  return applyEdits(text, modify(text, ["plugins"], plugins, { formattingOptions: { tabSize: 2, insertSpaces: true } }));
}

if (import.meta.main) {
  const plugin = resolve(import.meta.dir, ".."), path = resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "opencode/opencode.json");
  const text = (() => { try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}\n"; throw error; } })();
  const updated = installConfig(text, plugin, process.env.FOSSA_API_URL ?? DEFAULT_API_URL);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, updated + (updated.endsWith("\n") ? "" : "\n"), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
  console.log("Fossa installed. Run: opencode auth login fossa");
}
