import { expect, test } from "bun:test";
import { installMessageFooters } from "../src/message-footer";
import { BoxRenderable, RGBA, TextNodeRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "solid-js";

test.each(["fossa", "other-provider"])("preserves completed %s chat content, code and user messages", async providerID => {
  const markdown = (id: string, content: string) => ({ id, content, streaming: false, tableOptions: undefined, isDestroyed: false, getChildren: () => [] });
  const reply = markdown("session-part:reply:text:0", "hello\n\n@22@"), code = markdown("session-part:reply:text:1", "```\n@22@\n```"), user = markdown("session-part:user:text:0", "show @22@");
  let draw!: () => Promise<void>;
  const context = {
    client: { rpc: () => ({ routes: async () => ({ routes: [] }), events: { on: () => () => {} } }) },
    ui: { router: { current: () => ({ type: "session", sessionID: "test" }) } },
    data: { session: { message: { list: () => [
      { id: "reply", type: "assistant", model: { providerID, id: "test" }, time: { created: 1, completed: 2 } },
      { id: "user", type: "user" },
    ] } }, location: { model: { list: () => [] } } },
    renderer: { root: { id: "root", getChildren: () => [reply, code, user] }, requestRender: () => {}, setFrameCallback: (callback: typeof draw) => { draw = callback; }, removeFrameCallback: () => {} },
  };
  const stop = installMessageFooters(context as never);
  try {
    await draw();
    expect(reply.content).toBe("hello\n\n@22@");
    expect(code.content).toBe("```\n@22@\n```");
    expect(user.content).toBe("show @22@");
    await draw();
    expect(reply.content).toBe("hello\n\n@22@");
  } finally { stop(); }
  expect(reply.content).toBe("hello\n\n@22@");
});

test("adds provider to native footer without replacing styled text or refetching each status event", async () => {
  const t = await createTestRenderer({ width: 120, height: 40 }), ink = RGBA.fromHex("#ffffff"), muted = RGBA.fromHex("#888888");
  const message = new BoxRenderable(t.renderer, { id: "reply", height: 1 });
  const text = new TextRenderable(t.renderer, { fg: ink });
  const original = new TextNodeRenderable({ fg: ink, attributes: 1 }); original.children = ["build · Fixture model"]; text.add(original); message.add(text); t.renderer.root.add(message);
  let draw!: () => Promise<void>, event!: (event: { data: object }) => void, queries = 0;
  const context = {
    client: { rpc: () => ({ routes: async () => { queries++; return { routes: [{ id: "request", model: "fixture", provider: "Provider", startedAt: 20 }] }; }, events: { on: (_: string, callback: typeof event) => { event = callback; return () => {}; } } }) },
    ui: { router: { current: () => ({ type: "session", sessionID: "test" }) } },
    data: { session: { message: { list: () => [{ id: "reply", type: "assistant", agent: "build", model: { providerID: "fossa", id: "fixture" }, time: { created: 10, completed: 30 } }] } }, location: { model: { list: () => [{ id: "fixture", name: "Fixture model", providerID: "fossa" }] } } },
    theme: { text: { muted } },
    renderer: { root: t.renderer.root, requestRender: () => {}, setFrameCallback: (callback: typeof draw) => { draw = callback; }, removeFrameCallback: () => {} },
  };
  let dispose!: () => void;
  const stop = createRoot(owner => { dispose = owner; return installMessageFooters(context as never); });
  try {
    event({ data: { sessionID: "test", requestId: "request", provider: "Provider", stage: "matched" } });
    await Promise.resolve(); await t.renderOnce(); await draw(); await t.renderOnce();
    expect(text.plainText).toBe("build · Fixture model · Provider"); expect(text.getTextChildren()).toContain(original); expect(original.attributes).toBe(1);
    event({ data: { sessionID: "test", requestId: "request", provider: "Provider", stage: "matched" } }); await Promise.resolve();
    const afterMatch = queries;
    for (const stage of ["streaming", "settling", "idle"]) event({ data: { sessionID: "test", requestId: "request", provider: "Provider", stage } });
    await Promise.resolve(); expect(queries).toBe(afterMatch);
    for (let index = 0; index < 1000; index++) await draw();
    expect(queries).toBe(afterMatch); expect(text.plainText).toBe("build · Fixture model · Provider");
    stop(); await t.renderOnce(); expect(text.plainText).toBe("build · Fixture model"); expect(original.attributes).toBe(1);
  } finally { stop(); dispose(); await t.dispose(); }
});
