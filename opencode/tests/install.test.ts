import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { installConfig } from "../scripts/install";

test("local installation replaces GitHub plugin sources without duplicate registration", () => {
  const result = JSON.parse(installConfig(JSON.stringify({ plugins: ["github:usefossa/client#v0.10.10::path:opencode", "github:usefossa/client#::path:opencode", { package: "github:usefossa/client#main::path:opencode", options: { custom: true } }, "other-plugin"] }), "/fixture/fossa"));
  expect(result.plugins).toHaveLength(2); expect(result.plugins[0]).toBe("other-plugin"); expect(result.plugins[1].package).toBe("/fixture/fossa");
});

test("local installation replaces owned semver references while preserving options and unrelated sources", () => {
  const unrelated = { package: "github:other/client#semver:*::path:opencode", options: { custom: true } };
  for (const ref of ["*", "^0.13.0", ">=0.13.0 <1.0.0"]) {
    const options = { custom: true, apiUrl: "https://api.example.test" };
    const source = JSON.stringify({ model: "other/model", plugins: [unrelated, { package: `github:usefossa/client#semver:${ref}::path:opencode`, options }] });
    const updated = installConfig(source, "/fixture/fossa", options.apiUrl), value = parse(updated);
    expect(value).toEqual({ model: "other/model", plugins: [unrelated, { package: "/fixture/fossa", options }] });
    expect(parse(installConfig(updated, "/fixture/fossa", options.apiUrl))).toEqual(value);
  }
});
import { DEFAULT_API_URL } from "../src/api";

test("standalone installer replaces old source and endpoint while preserving unrelated configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "fossa-install-")), old = join(root, "old"), plugin = join(root, "client/opencode");
  try {
    mkdirSync(old); writeFileSync(join(old, "package.json"), JSON.stringify({ name: "@fossa/opencode" }));
    const unrelated = { package: "other-plugin", options: { apiUrl: "https://other.test" } };
    const source = `// keep comment\n${JSON.stringify({ model: "other/model", plugins: [unrelated, { package: old, options: { apiUrl: "http://127.0.0.1:8787", keep: true } }, "@fossa/opencode"] })}`;
    const updated = installConfig(source, plugin), value = parse(updated);
    expect(updated).toStartWith("// keep comment");
    expect(value.model).toBe("other/model");
    expect(value.plugins).toEqual([unrelated, { package: plugin, options: { apiUrl: DEFAULT_API_URL, keep: true } }]);
    expect(parse(installConfig(updated, plugin))).toEqual(value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installer supports explicit custom APIs and rejects malformed configuration or insecure endpoints", () => {
  expect(parse(installConfig("{}", "/client/opencode", "http://127.0.0.1:9000/")).plugins[0].options.apiUrl).toBe("http://127.0.0.1:9000");
  for (const source of ["{broken", "[]", '{"plugins":{}}']) expect(() => installConfig(source, "/client/opencode")).toThrow("configuration is invalid");
  for (const endpoint of ["http://remote.test", "https://user:password@api.test"]) expect(() => installConfig("{}", "/client/opencode", endpoint)).toThrow("Use HTTPS");
});
