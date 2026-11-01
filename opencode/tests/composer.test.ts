import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/tui/context";
import { RGBA, type BoxRenderable } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import { jsx, type JSX } from "@opentui/solid/jsx-runtime";
import { installComposer } from "../src/composer";
import type { ModelDetails } from "../src/types";

test("provider preview shows connection failures and recovers without stale offers", async () => {
  const ink = RGBA.fromHex("#ffffff"), muted = RGBA.fromHex("#888888"), background = RGBA.fromHex("#222222");
  const theme = { text: { base: ink, muted }, hue: { accent: { 200: ink } }, background: { raised: { base: background } }, surface: () => ({ background: { action: { primary: { focused: background } } }, text: { action: { primary: { focused: ink } } } }) };
  let details: ModelDetails | undefined, error: string | undefined, stop!: () => void, draw!: (deltaTime: number) => Promise<void>;
  let shell!: BoxRenderable, providerID = "fossa", route = "home", balance = "$0.00";
  const model: ModelDetails = { id: "fixture/model", name: "Fixture model", settings: { mode: "balanced", minSpeed: 0, zdrOnly: false }, offers: [{ provider: "Fixture provider", wallet: "fixture", url: "https://example.com", input: 0.1, output: 0.2, cached: 0.03, speed: 100, zdr: true }] };
  const t = await testRender(() => {
    const renderer = useRenderer(), setFrameCallback = renderer.setFrameCallback.bind(renderer);
    renderer.setFrameCallback = callback => { draw = callback; setFrameCallback(callback); };
    let slot!: (input: { mode: "normal" }) => JSX.Element;
    const context = { renderer, theme, ui: {
      model: { current: () => ({ providerID, modelID: model.id }) }, router: { current: () => ({ type: route }) },
      slot: (input: { render: typeof slot }) => { slot = input.render; return () => {}; },
    } } as unknown as Context;
    stop = installComposer(context, () => details, () => balance, () => {}, () => {}, () => error, { version: () => {}, modalities: () => {}, limits: () => {} });
    return jsx("box", { width: "100%", alignItems: "center", paddingX: 2, get children() {
      return jsx("box", { width: "100%", maxWidth: 75, ref: (node: BoxRenderable) => { shell = node; }, get children() {
        return jsx("box", { width: "100%", get children() { return jsx("box", { get children() { return slot({ mode: "normal" }); } }); } });
      } });
    } });
  }, { width: 120, height: 20 });
  const frame = async () => { for (let index = 0; index < 3; index++) { await draw(0); await t.renderOnce(); } return t.captureCharFrame(); };
  try {
    expect(await frame()).toContain("Loading providers…");
    error = "Run /connect to connect your Fossa account.";
    expect(await frame()).toContain(error); expect(await frame()).not.toContain("Loading providers");
    details = model; error = undefined;
    expect(await frame()).toContain("Fixture provider"); expect(await frame()).not.toContain("/connect");
    expect(shell.width).toBe(75);
    error = "Run /connect to connect your Fossa account.";
    expect(await frame()).toContain(error); expect(await frame()).not.toContain("Fixture provider");
    error = undefined;
    expect(await frame()).toContain("Fixture provider");
    details = { ...model, settings: { ...model.settings, advancedRouting: true, inputModalities: 3, outputModalities: 1, minContextTokens: 32768 }, checkpoint: "07".repeat(32), checkpoints: [{ hash: "07".repeat(32), name: "1017", order: 0 }] };
    const advanced = await frame(); expect(advanced).toContain("Version  1017"); expect(advanced).toContain("2 Active"); expect(advanced).toContain("Limits  Custom");
    expect(advanced.split("\n").find(line => line.includes("Price  Auto"))).toContain("Limits  Custom");
    expect(shell.width).toBeGreaterThan(75); const initialWidth = shell.width;
    expect(shell.x).toBe(Math.floor((120 - shell.width) / 2));
    balance = "$123456.78"; await frame(); expect(shell.width).toBeGreaterThan(initialWidth);
    t.renderer.resize(85, 20); await frame(); expect(shell.width).toBeLessThanOrEqual(81);
    t.renderer.resize(120, 20); await frame(); expect(shell.width).toBeGreaterThan(75);
    route = "session"; await frame(); expect(shell.width).toBe(75);
    route = "home"; await frame(); expect(shell.width).toBeGreaterThan(75);
    providerID = "other"; await frame(); expect(shell.width).toBe(75);
    providerID = "fossa"; await frame(); expect(shell.width).toBeGreaterThan(75);
    details = { ...model, offers: [] };
    expect(await frame()).toContain("No providers match your filters.");
    expect(shell.width).toBe(75);
    details = { ...model, settings: { ...model.settings, advancedRouting: true } }; await frame();
    stop(); await t.renderOnce(); expect(shell.width).toBe(75);
  } finally { stop(); await t.dispose(); }
});
