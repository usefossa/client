import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/tui/context";
import { RGBA } from "@opentui/core";
import { testRender, useRenderer } from "@opentui/solid";
import { jsx, type JSX } from "@opentui/solid/jsx-runtime";
import { installComposer } from "../src/composer";
import type { ModelDetails } from "../src/types";

test("provider preview shows connection failures and recovers without stale offers", async () => {
  const ink = RGBA.fromHex("#ffffff"), muted = RGBA.fromHex("#888888"), background = RGBA.fromHex("#222222");
  const theme = { text: { base: ink, muted }, hue: { accent: { 200: ink } }, background: { raised: { base: background } }, surface: () => ({ background: { action: { primary: { focused: background } } }, text: { action: { primary: { focused: ink } } } }) };
  let details: ModelDetails | undefined, error: string | undefined, stop!: () => void, draw!: (deltaTime: number) => Promise<void>;
  const model: ModelDetails = { id: "fixture/model", name: "Fixture model", settings: { mode: "balanced", minSpeed: 0, zdrOnly: false }, offers: [{ provider: "Fixture provider", wallet: "fixture", url: "https://example.com", input: 0.1, output: 0.2, cached: 0.03, speed: 100, zdr: true }] };
  const t = await testRender(() => {
    const renderer = useRenderer(), setFrameCallback = renderer.setFrameCallback.bind(renderer);
    renderer.setFrameCallback = callback => { draw = callback; setFrameCallback(callback); };
    let slot!: (input: { mode: "normal" }) => JSX.Element;
    const context = { renderer, theme, ui: {
      model: { current: () => ({ providerID: "fossa", modelID: model.id }) }, router: { current: () => ({ type: "home" }) },
      slot: (input: { render: typeof slot }) => { slot = input.render; return () => {}; },
    } } as unknown as Context;
    stop = installComposer(context, () => details, () => "$0.00", () => {}, () => {}, () => error);
    return jsx("box", { width: "100%", get children() { return jsx("box", { get children() { return slot({ mode: "normal" }); } }); } });
  }, { width: 100, height: 20 });
  const frame = async () => { await draw(0); await t.renderOnce(); return t.captureCharFrame(); };
  try {
    expect(await frame()).toContain("Loading providers…");
    error = "Run /connect to connect your Fossa account.";
    expect(await frame()).toContain(error); expect(await frame()).not.toContain("Loading providers");
    details = model; error = undefined;
    expect(await frame()).toContain("Fixture provider"); expect(await frame()).not.toContain("/connect");
    error = "Run /connect to connect your Fossa account.";
    expect(await frame()).toContain(error); expect(await frame()).not.toContain("Fixture provider");
    error = undefined;
    expect(await frame()).toContain("Fixture provider");
    details = { ...model, offers: [] };
    expect(await frame()).toContain("No providers match your filters.");
  } finally { stop(); await t.dispose(); }
});
