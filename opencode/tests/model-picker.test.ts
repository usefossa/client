import { expect, test } from "bun:test";
import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { Context } from "@opencode/plugin/tui/context";
import { installModelPicker } from "../src/model-picker";
import type { ModelDetails } from "../src/types";

const find = (node: Renderable, id: string): Renderable | undefined => node.id === id ? node : node.getChildren().map(child => find(child, id)).find(Boolean);
const model: ModelDetails = { id: "fixture/model", name: "Fixture model", settings: { mode: "balanced", minSpeed: 0, zdrOnly: false }, offers: [
  { provider: "Best provider", wallet: "best", url: "https://example.com/best", input: 0.1, output: 0.28, cached: 0.03, speed: 100, zdr: true },
  { provider: "Other provider", wallet: "other", url: "https://example.com/other", input: 0.2, output: 0.56, cached: 0.06, speed: 80, zdr: true },
] };

for (const wrappers of [0, 3]) test(`native provider pane matches selector, recenters, and toggles with ${wrappers} wrappers`, async () => {
  const t = await createTestRenderer({ width: 170, height: 50 });
  const focused = RGBA.fromHex("#303030"), base = RGBA.fromHex("#101010"), text = RGBA.fromHex("#ffffff"), muted = RGBA.fromHex("#808080"), accent = RGBA.fromHex("#bb88ff"), blue = RGBA.fromHex("#4488ff");
  const overlay = new BoxRenderable(t.renderer, { width: "100%", height: "100%", position: "absolute", alignItems: "center", paddingTop: 10 });
  const shell = new BoxRenderable(t.renderer, { width: 60, height: 16, backgroundColor: base });
  const originalLeft = shell.left, originalTop = shell.top;
  overlay.add(shell); t.renderer.root.add(overlay);
  let parent = shell;
  for (let index = 0; index < wrappers; index++) { const box = new BoxRenderable(t.renderer, { width: "100%", height: "100%" }); parent.add(box); parent = box; }
  const scroll = new ScrollBoxRenderable(t.renderer, { height: 10, scrollX: false }); parent.add(scroll);
  scroll.add(new TextRenderable(t.renderer, { content: "Recent", attributes: 1, fg: accent }));
  const selected = new BoxRenderable(t.renderer, { flexDirection: "row", backgroundColor: focused, height: 1 });
  selected.add(new TextRenderable(t.renderer, { content: "Fixture model", fg: text }));
  selected.add(new TextRenderable(t.renderer, { content: "Fossa", fg: muted })); scroll.add(selected);
  const other = new BoxRenderable(t.renderer, { flexDirection: "row", height: 1 });
  other.add(new TextRenderable(t.renderer, { content: "Other model", fg: text })); scroll.add(other);
  const preference = { modelPane: true };
  let queries = 0, scan!: (deltaTime: number) => Promise<void>, command!: { id: string; bind: string | false; run: () => void };
  const setFrameCallback = t.renderer.setFrameCallback.bind(t.renderer);
  t.renderer.setFrameCallback = callback => { scan = callback; setFrameCallback(callback); };
  const context = {
    renderer: t.renderer, client: { rpc: () => ({ model: async () => { queries++; return structuredClone(model); } }) },
    storage: { store: () => [preference, async (update: (draft: typeof preference) => void) => { await Promise.resolve(); update(preference); }] },
    keymap: { commands: () => [{ id: "model.dialog.favorite" }, { id: "occupied" }], shortcuts: (id: string) => id === "occupied" ? ["ctrl+g"] : id === command?.id && command.bind ? [command.bind] : [], layer: (factory: () => { commands: typeof command[] }) => { command = factory().commands[0]; } },
    data: { location: { model: { list: () => [{ id: model.id, name: model.name, providerID: "fossa" }] }, provider: { list: () => [{ name: "Fossa" }] } } },
    theme: { text: { base: text, muted }, surface: () => ({ background: { base, action: { primary: { focused } } }, hue: { accent: { 200: accent }, interactive: { 200: blue } } }) },
  } as unknown as Context;
  let stop = installModelPicker(context);
  const render = async () => { for (let index = 0; index < 4; index++) await t.renderOnce(); };
  try {
    await render();
    let frame = find(t.renderer.root, "fossa-picker-frame")!;
    expect(frame).toBeDefined(); expect(frame.parent).toBe(overlay);
    expect(frame.width).toBe(shell.width); expect(frame.height).toBe(shell.height);
    expect(frame.x).toBe(shell.x + shell.width + 2); expect(frame.y).toBe(shell.y);
    expect((frame as BoxRenderable).backgroundColor.equals(base)).toBe(true);
    expect(command.bind).toBe("ctrl+y");
    const first = find(frame, "fossa-picker-provider-0") as BoxRenderable;
    expect(first.backgroundColor.a).toBe(0);
    const dot = first.getChildren()[0] as TextRenderable, name = first.getChildren()[1] as TextRenderable;
    expect(dot.plainText).toBe("●"); expect(dot.fg.equals(blue)).toBe(true);
    expect(name.plainText).toBe("Best provider"); expect(name.fg.equals(blue)).toBe(true);
    const metadata = first.getChildren()[2] as TextRenderable;
    expect(metadata.plainText).toBe("0.10/0.28/0.03  100 T/S"); expect(metadata.fg.equals(muted)).toBe(true);
    const textContent = [...function* walk(node: Renderable): Generator<string> { if ("plainText" in node) yield String(node.plainText); for (const child of node.getChildren()) yield* walk(child); }(frame)].join(" ");
    expect(textContent).toContain("Matching filters"); expect(textContent).toContain("Toggle this panel ctrl+y"); expect(textContent).not.toContain("esc");
    let rootScans = 0;
    const getChildren = t.renderer.root.getChildren.bind(t.renderer.root);
    t.renderer.root.getChildren = () => { rootScans++; return getChildren(); };
    const started = performance.now();
    for (let index = 0; index < 1000; index++) await scan(0);
    const elapsed = performance.now() - started;
    expect(rootScans).toBe(0); expect(queries).toBe(1);
    expect(find(frame, "fossa-picker-provider-0")).toBe(first);
    console.info(`provider pane: 1000 scans ${elapsed.toFixed(2)}ms, ${rootScans} full-tree scans, ${queries} model query`);
    t.renderer.root.getChildren = getChildren;
    const hide = stop.toggle(); expect(stop.enabled()).toBe(false); await hide; await render();
    expect(find(t.renderer.root, "fossa-picker-frame")).toBeUndefined();
    expect(shell.x).toBe(Math.floor((t.renderer.width - shell.width) / 2));
    const show = stop.toggle(); expect(stop.enabled()).toBe(true); await show; await render();
    expect(find(t.renderer.root, "fossa-picker-frame")).toBeDefined();
    await Promise.all([stop.toggle(), stop.toggle()]); await render();
    expect(stop.enabled()).toBe(true); expect(find(t.renderer.root, "fossa-picker-frame")).toBeDefined();
    selected.backgroundColor = "transparent"; other.backgroundColor = focused;
    await render(); expect(find(t.renderer.root, "fossa-picker-frame")).toBeUndefined();
    expect(shell.x).toBe(Math.floor((t.renderer.width - shell.width) / 2));
    expect(shell.left).toBe(originalLeft ?? "auto"); expect(shell.top).toBe(originalTop ?? "auto");
    command.run(); await Promise.resolve(); expect(stop.enabled()).toBe(false);
    other.backgroundColor = "transparent"; selected.backgroundColor = focused;
    await render(); expect(find(t.renderer.root, "fossa-picker-frame")).toBeUndefined();
    await stop.toggle(); await render(); expect(find(t.renderer.root, "fossa-picker-frame")).toBeDefined();
    shell.width = 64; shell.height = 18; await render();
    frame = find(t.renderer.root, "fossa-picker-frame")!;
    expect(frame.width).toBe(64); expect(frame.height).toBe(18);
    t.resize(78, 50); await render(); frame = find(t.renderer.root, "fossa-picker-frame")!;
    expect(frame.x).toBe(shell.x); expect(frame.y).toBe(shell.y + shell.height + 2);
    expect(frame.width).toBe(shell.width); expect(frame.height).toBe(shell.height);
    expect(frame.y + frame.height).toBeLessThanOrEqual(50);
    t.resize(80, 24); await render(); expect(find(t.renderer.root, "fossa-picker-frame")).toBeUndefined();
    expect(shell.left).toBe(originalLeft ?? "auto"); expect(shell.top).toBe(originalTop ?? "auto");
    await stop.toggle(); stop(); stop = installModelPicker(context);
    expect(stop.enabled()).toBe(false);
  } finally { stop(); await t.dispose(); }
});
