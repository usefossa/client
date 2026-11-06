import { readFile } from "node:fs/promises";

export function dependencyManifest(lock) {
  if (lock.lockfileVersion !== 1 || !lock.packages || !lock.workspaces?.[""]) throw new Error("unsupported bun lockfile");
  const workspace = lock.workspaces[""];
  const direct = { ...workspace.dependencies, ...workspace.devDependencies, ...workspace.optionalDependencies };
  const resolved = Object.fromEntries(Object.entries(lock.packages).map(([key, value]) => {
    const match = Array.isArray(value) && /^((?:@[^/\s]+\/)?[^@/\s]+)@(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)$/.exec(value[0]);
    if (!match) throw new Error(`unsupported locked package: ${key}`);
    const [, name, version] = match;
    const encoded = name.split("/").map(encodeURIComponent).join("/");
    return [key, { package_url: `pkg:npm/${encoded}@${encodeURIComponent(version)}`, relationship: Object.hasOwn(direct, key) ? "direct" : "indirect" }];
  }));
  if (!Object.keys(resolved).length) throw new Error("empty dependency inventory");
  return { name: "bun.lock", file: { source_location: "bun.lock" }, resolved };
}

if (import.meta.main) {
  const lockPath = process.argv.find(value => value.endsWith("bun.lock")) ?? "bun.lock";
  const manifest = dependencyManifest(Bun.JSONC.parse(await readFile(lockPath, "utf8")));
  manifest.name = lockPath; manifest.file.source_location = lockPath;
  if (process.argv.includes("--check")) {
    console.log(`validated ${Object.keys(manifest.resolved).length} locked dependencies`);
  } else {
    const { GITHUB_ACTIONS, GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN } = process.env;
    if (GITHUB_ACTIONS !== "true" || GITHUB_REF !== "refs/heads/main" || !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? "") || !GITHUB_RUN_ID || !GITHUB_TOKEN) throw new Error("dependency submission requires trusted main CI");
    const snapshot = {
      version: 0, sha: GITHUB_SHA, ref: GITHUB_REF,
      job: { id: GITHUB_RUN_ID, correlator: `bun-lock-inventory:${lockPath}` },
      detector: { name: "bun-lock-inventory", version: "1.0.0", url: `https://github.com/${GITHUB_REPOSITORY}/blob/main/.github/dependency-graph.mjs` },
      scanned: new Date().toISOString(), manifests: { [lockPath]: manifest },
    };
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/dependency-graph/snapshots`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
      body: JSON.stringify(snapshot),
    });
    if (response.status !== 201) throw new Error(`dependency submission failed: HTTP ${response.status}`);
    console.log(`submitted ${Object.keys(manifest.resolved).length} locked dependencies`);
  }
}
