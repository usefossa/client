import { expect, test } from "bun:test";
import { BoxRenderable, InputRenderable, RGBA, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { Context } from "@opencode/plugin/tui/context";
import { createModelOrder } from "../src/ui/model-order";

test("Fossa follows favorites and recent with native keyboard selection, search, refresh and toggle restoration", async () => {
  const t = await createTestRenderer({ width: 80, height: 40 }), focused = RGBA.fromHex("#303030");
  const shell = new BoxRenderable(t.renderer, { width: 60, height: 30 }); t.renderer.root.add(shell);
  const input = new InputRenderable(t.renderer, { width: 50 }); shell.add(input);
  const scroll = new ScrollBoxRenderable(t.renderer, { height: 24 }); shell.add(scroll);
  let enabled = true, chosen = "", selected: BoxRenderable;
  const groups = ["Favorites", "Recent", "OpenCode", "Anthropic", "Fossa", "Zeta"];
  const headings: BoxRenderable[] = [], rows: BoxRenderable[] = [];
  const add = (name: string, first = false) => {
    const heading = new BoxRenderable(t.renderer, { height: first ? 1 : 2, paddingTop: first ? 0 : 1 });
    heading.add(new TextRenderable(t.renderer, { content: name, attributes: 1 })); scroll.add(heading); headings.push(heading);
    const row = new BoxRenderable(t.renderer, { height: 1 }); row.add(new TextRenderable(t.renderer, { content: name + " model" })); scroll.add(row); rows.push(row);
    row.onMouseDown = () => { if (selected) selected.backgroundColor = "transparent"; selected = row; selected.backgroundColor = focused; };
    row.onMouseUp = () => { chosen = name; };
  };
  groups.forEach((name, index) => add(name, index === 0));
  selected = rows[1]; selected.backgroundColor = focused;
  const context = { renderer: t.renderer, keymap: { shortcuts: (id: string) => [id] }, theme: { surface: () => ({ background: { action: { primary: { focused } } } }) } } as unknown as Context;
  const order = createModelOrder(context, () => enabled), categories = new Set(groups);
  const labels = () => scroll.getChildren().toSorted((a, b) => a.y - b.y).map(node => (node.getChildren()[0] as TextRenderable).plainText);
  const scan = async () => { await t.renderOnce(); order.scan(shell, scroll, categories); await t.renderOnce(); };
  try {
    await scan();
    expect(labels()).toEqual(["Favorites", "Favorites model", "Recent", "Recent model", "Fossa", "Fossa model", "OpenCode", "OpenCode model", "Anthropic", "Anthropic model", "Zeta", "Zeta model"]);
    const commands = order.commands();
    commands.find(command => command.id?.endsWith(".next"))!.run(); await scan();
    expect(selected).toBe(rows[4]);
    selected.processMouseEvent({ type: "up", propagationStopped: true } as never); expect(chosen).toBe("Fossa");
    commands.find(command => command.id?.endsWith(".prev"))!.run(); await scan(); expect(selected).toBe(rows[1]);
    commands.find(command => command.id?.endsWith(".home"))!.run(); await scan(); expect(selected).toBe(rows[0]);
    commands.find(command => command.id?.endsWith(".prev"))!.run(); await scan(); expect(selected).toBe(rows[5]);
    commands.find(command => command.id?.endsWith(".page_up"))!.run(); await scan(); expect(selected).toBe(rows[0]);
    input.value = "Fossa"; await scan(); expect(labels().filter((_, index) => index % 2 === 0)).toEqual(groups);
    expect(commands[0].run()).toBe(false);
    input.value = ""; await scan(); expect(labels()[4]).toBe("Fossa");
    const extra = new BoxRenderable(t.renderer, { height: 1 }); extra.add(new TextRenderable(t.renderer, { content: "New Fossa model" }));
    scroll.insertBefore(extra, headings[5]); await scan(); expect(labels().indexOf("New Fossa model")).toBe(6);
    enabled = false; await scan(); expect(labels().filter(label => groups.includes(label))).toEqual(groups);
    expect(headings[0].getChildren()[0].y - headings[0].y).toBe(0); expect(headings[4].getChildren()[0].y - headings[4].y).toBe(1);
  } finally { order.reset(); await t.dispose(); }
});

test("Fossa is first without favorites or recent and restores original heading spacing", async () => {
  const t = await createTestRenderer({ width: 80, height: 30 }), shell = new BoxRenderable(t.renderer, { width: 60, height: 20 }); t.renderer.root.add(shell);
  const scroll = new ScrollBoxRenderable(t.renderer, { height: 18 }); shell.add(scroll);
  for (const name of ["Anthropic", "Fossa"]) {
    const heading = new BoxRenderable(t.renderer, { paddingTop: name === "Anthropic" ? 0 : 1 }); heading.add(new TextRenderable(t.renderer, { content: name, attributes: 1 })); scroll.add(heading);
    scroll.add(new TextRenderable(t.renderer, { content: name + " model" }));
  }
  const original = scroll.getChildren();
  const context = { renderer: t.renderer, theme: { surface: () => ({ background: { action: { primary: { focused: RGBA.fromHex("#303030") } } } }) } } as unknown as Context;
  const order = createModelOrder(context, () => true);
  try {
    await t.renderOnce(); order.scan(shell, scroll, new Set(["Anthropic", "Fossa"])); await t.renderOnce();
    expect(original[2].y).toBeLessThan(original[0].y); expect(original[2].getChildren()[0].y - original[2].y).toBe(0);
    order.reset(); await t.renderOnce(); expect(scroll.getChildren()).toEqual(original); expect(original[0].y).toBeLessThan(original[2].y); expect(original[2].getChildren()[0].y - original[2].y).toBe(1);
    for (const node of original) { scroll.remove(node); node.destroyRecursively(); }
    expect(() => order.scan(shell, scroll, new Set(["Fossa"]))).not.toThrow();
  } finally { order.reset(); await t.dispose(); }
});
