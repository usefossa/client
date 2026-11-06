import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyManifest } from "./dependency-graph.mjs";

test("inventory preserves exact direct, scoped, nested and prerelease package versions", () => {
  const manifest = dependencyManifest({ lockfileVersion: 1, workspaces: { "": { dependencies: { react: "^19.0.0" }, devDependencies: { "@scope/tool": "1.2.3" } } }, packages: {
    react: ["react@19.3.0"], "@scope/tool": ["@scope/tool@1.2.3"], "other/react": ["react@18.3.1"], dependency: ["dependency@2.0.0-rc.1+build.2"],
  } });
  assert.equal(manifest.resolved.react.package_url, "pkg:npm/react@19.3.0");
  assert.equal(manifest.resolved.react.relationship, "direct");
  assert.equal(manifest.resolved["@scope/tool"].package_url, "pkg:npm/%40scope/tool@1.2.3");
  assert.equal(manifest.resolved["other/react"].package_url, "pkg:npm/react@18.3.1");
  assert.equal(manifest.resolved["other/react"].relationship, "indirect");
  assert.equal(manifest.resolved.dependency.package_url, "pkg:npm/dependency@2.0.0-rc.1%2Bbuild.2");
});

test("inventory rejects unsupported, unresolved and empty locks rather than silently dropping packages", () => {
  assert.throws(() => dependencyManifest({ lockfileVersion: 2 }));
  for (const packages of [{}, { package: ["package@https://example.test/archive"] }, { package: ["package@^1.0.0"] }]) {
    assert.throws(() => dependencyManifest({ lockfileVersion: 1, workspaces: { "": {} }, packages }));
  }
});
