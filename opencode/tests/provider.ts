import { join } from "node:path";

export async function rustProvider(input: { rpc: string; program: string; market: string; mint: string; seed: number[] }) {
  const root = process.env.FOSSA_PROVIDER_ROOT;
  if (!root) throw Error("Set FOSSA_PROVIDER_ROOT and build cargo example client-fixture first.");
  const child = Bun.spawn([join(root, "target/debug/examples/client-fixture")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const close = async () => { child.kill("SIGTERM"); await child.exited; };
  try {
    child.stdin.write(JSON.stringify(input) + "\n");
    child.stdin.end();
    const reader = child.stdout.getReader();
    const result = await reader.read(); reader.releaseLock();
    const url = new TextDecoder().decode(result.value).trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw Error("Rust provider fixture failed to start.");
    return { url, close };
  } catch (error) { await close(); throw error; }
}
