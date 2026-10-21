import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/tui/context";
import { RGBA, type Renderable, type BoxRenderable } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal } from "solid-js";
import { jsx, type JSX } from "@opentui/solid/jsx-runtime";
import { settingsDialog } from "../src/settings-dialog";

test("packaged dialog keeps navigation, page updates, search and prompts reactive", async () => {
  const base = RGBA.fromHex("#ffffff"), muted = RGBA.fromHex("#888888"), focused = RGBA.fromHex("#444444");
  const theme = { text: { base, muted, action: { primary: { focused: base } }, formfield: { focused: base, selected: base } }, background: { action: { primary: { focused } }, formfield: { focused }, raised: { base: muted } }, hue: { accent: { 200: base } } };
  let dialog!: ReturnType<typeof settingsDialog>, commands!: { id: string; run: () => void }[], close: (() => void) | undefined;
  const t = await testRender(() => {
    const [content, setContent] = createSignal<(() => JSX.Element) | undefined>();
    const context = { renderer: useRenderer(), theme: { surface: () => theme }, keymap: { layer: (factory: () => { commands: typeof commands }) => { commands = factory().commands; } }, ui: { dialog: {
      show: (render: () => JSX.Element, onClose: () => void) => { close = onClose; setContent(() => render); },
      clear: () => { setContent(undefined); close?.(); },
    } } } as unknown as Context;
    dialog = settingsDialog(context);
    return jsx("box", { width: "100%", height: "100%", get children() { return content()?.(); } });
  }, { width: 90, height: 30 });
  const frame = async () => { await Promise.resolve(); await t.renderOnce(); return t.captureCharFrame(); };
  const find = (node: Renderable, id: string): Renderable | undefined => node.id === id ? node : node.getChildren().map(child => find(child, id)).find(Boolean);
  const run = (name: string) => commands.find(command => command.id === `fossa.dialog.${name}`)!.run();
  try {
    dialog.begin();
    const choice = dialog.select({ title: "Model pane", current: "on", options: [{ title: "On", value: "on" }, { title: "Off", value: "off" }] });
    expect(await frame()).toContain("Model pane");
    run("down"); await frame();
    expect((find(t.renderer.root, "fossa-option-1") as BoxRenderable).backgroundColor.equals(focused)).toBe(true);
    expect((find(t.renderer.root, "fossa-option-0") as BoxRenderable).backgroundColor.a).toBe(0);
    run("submit"); expect(await choice).toBe("off");
    const options = [{ title: "Data retention", value: "retention", footer: "Allow" }, { title: "Methodology", value: "mode", footer: "Balanced" }];
    const settings = dialog.select({ title: "Routing", search: true, options });
    expect(await frame()).toContain("Routing"); expect(await frame()).toContain("Balanced");
    dialog.update("Routing", { options: [{ ...options[0], footer: "Zero data retention" }, options[1]] });
    expect(await frame()).toContain("Zero data retention");
    await t.mockInput.typeText("method");
    expect(await frame()).toContain("Methodology"); expect(await frame()).not.toContain("Data retention");
    await t.mockInput.typeText("missing"); expect(await frame()).toContain("No results");
    run("back"); expect(await settings).toBeUndefined();
    const prompt = dialog.prompt({ title: "API endpoint", value: "https://example.com" });
    expect(await frame()).toContain("API endpoint"); expect(await frame()).toContain("https://example.com");
    await t.mockInput.typeText("/v1"); run("submit"); expect(await prompt).toBe("https://example.com/v1");
  } finally { dialog.close(); await t.dispose(); }
});
