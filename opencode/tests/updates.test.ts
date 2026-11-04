import { expect, mock, test } from "bun:test";
import type { Context } from "@opencode/plugin/tui/context";
import type { PluginInfo } from "@opencode/client";
import { installUpdateNotice } from "../src/ui/updates";

function fixture(local = false) {
  const target = "github:usefossa/client#::path:opencode", location = { directory: "/fixture" };
  const plugin: PluginInfo = { id: "fossa", source: local ? { type: "local", path: "/fixture/plugin" } : { type: "package", target, version: "0.17.2" }, features: { server: true, tui: true }, state: { status: "active" } };
  const outdated: PluginInfo = { ...plugin, source: { type: "package", target, version: "0.17.2", outdated: true } };
  const list = mock(async (..._args: unknown[]): Promise<{ data: PluginInfo[] }> => ({ data: [plugin] }));
  const check = mock(async (..._args: unknown[]): Promise<{ data: PluginInfo[] }> => ({ data: [outdated] }));
  const show = mock(), notice = { shown: [] as string[] }, frames = new Set<(delta: number) => Promise<void>>();
  const context = { location, options: {}, client: { plugin: { list, check } }, ui: { toast: { show } },
    renderer: { setFrameCallback: (frame: (delta: number) => Promise<void>) => frames.add(frame), removeFrameCallback: (frame: (delta: number) => Promise<void>) => frames.delete(frame) },
    storage: { memory: () => [notice, (update: (value: typeof notice) => void) => update(notice)] },
  } as unknown as Context;
  const frame = async () => { for (const callback of [...frames]) await callback(0); await Bun.sleep(0); };
  return { context, target, location, plugin, outdated, list, check, show, frames, frame };
}

test("update check waits for rendering, scopes the installed package, and avoids duplicate notices after reload", async () => {
  const f = fixture();
  let stop = installUpdateNotice(f.context);
  try {
    expect(f.list).not.toHaveBeenCalled(); expect(f.show).not.toHaveBeenCalled();
    await f.frame();
    expect(f.check.mock.calls[0]?.[0]).toEqual({ location: f.location, target: f.target });
    expect(f.show).toHaveBeenCalledTimes(1);
    expect(f.show.mock.calls[0]?.[0]).toMatchObject({ title: "Fossa update available", message: expect.stringContaining("Close OpenCode, run opencode plugin update") });
    stop(); stop = installUpdateNotice(f.context); await f.frame();
    expect(f.show).toHaveBeenCalledTimes(1);
  } finally { stop(); }
});

test("local installs skip update checks", async () => {
  const f = fixture(true), stop = installUpdateNotice(f.context);
  try { await f.frame(); expect(f.check).not.toHaveBeenCalled(); expect(f.show).not.toHaveBeenCalled(); }
  finally { stop(); }
});

test("updates to unrelated plugins do not produce a Fossa notice", async () => {
  const f = fixture();
  f.check.mockImplementation(async () => ({ data: [f.plugin, { ...f.outdated, source: { type: "package", target: "unrelated-plugin", outdated: true } }] }));
  const stop = installUpdateNotice(f.context);
  try { await f.frame(); expect(f.show).not.toHaveBeenCalled(); }
  finally { stop(); }
});

test("disposal aborts checks and suppresses late notices", async () => {
  const f = fixture();
  let release!: (value: Awaited<ReturnType<typeof f.check>>) => void;
  f.check.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const stop = installUpdateNotice(f.context);
  try {
    await f.frame(); expect(f.check).toHaveBeenCalledTimes(1);
    const options = f.check.mock.calls[0][1] as { signal: AbortSignal };
    stop(); expect(options.signal.aborted).toBe(true);
    release({ data: [f.outdated] }); await Bun.sleep(0);
    expect(f.show).not.toHaveBeenCalled(); expect(f.frames.size).toBe(0);
  } finally { stop(); }
});

test("explicit simulation uses the normal notice without checking packages", async () => {
  const f = fixture(true); (f.context.options as Record<string, unknown>).simulateUpdate = true;
  const stop = installUpdateNotice(f.context);
  try { await f.frame(); expect(f.show).toHaveBeenCalledTimes(1); expect(f.list).not.toHaveBeenCalled(); }
  finally { stop(); }
});
