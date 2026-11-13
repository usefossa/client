import type { BoxRenderable, MouseEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context";
import { isText, visibleNodes } from "./render-tree";

export function createModelOrder(context: Context, enabled: () => boolean) {
  let list: ScrollBoxRenderable | undefined, original: Renderable[] = [], ordered: Renderable[] = [], rows: Renderable[] = [];
  let selected: Renderable | undefined;
  const positions = new Map<Renderable, Renderable["top"]>(), padding = new Map<Renderable, number>();
  const reset = () => {
    for (const [node, top] of positions) if (!node.isDestroyed) node.top = top ?? "auto";
    for (const [node, value] of padding) if (!node.isDestroyed) (node as BoxRenderable).paddingTop = value;
    positions.clear(); padding.clear(); list = undefined; original = ordered = rows = []; selected = undefined;
  };
  const highlighted = (node: Renderable) => [...visibleNodes(node)].some(child => "backgroundColor" in child && (child as BoxRenderable).backgroundColor.equals(context.theme.surface("dialog").background.action.primary.focused));
  const reveal = (node: Renderable) => {
    const offset = node.y - list!.viewport.y;
    if (offset < 0) list!.scrollBy(offset);
    else if (offset + node.height > list!.viewport.height) list!.scrollBy(offset + node.height - list!.viewport.height);
  };
  return {
    reset,
    scan(shell: Renderable, scroll: ScrollBoxRenderable, categories: Set<string>) {
      if (!enabled() || [...visibleNodes(shell)].some(node => "value" in node && typeof node.value === "string" && node.value.trim())) { reset(); return; }
      if (list && list !== scroll) reset();
      const children = scroll.getChildren();
      if (!children.length) { reset(); return; }
      if (children.length !== original.length || children.some((node, index) => node !== original[index])) {
        reset(); list = scroll; original = scroll.getChildren();
        const groups: { name: string; nodes: Renderable[] }[] = [];
        for (const node of original) {
          const heading = [...visibleNodes(node)].find(child => isText(child) && child.attributes & 1 && categories.has(child.plainText));
          if (heading && isText(heading)) groups.push({ name: heading.plainText, nodes: [] });
          if (!groups.length) { reset(); return; }
          groups.at(-1)!.nodes.push(node);
        }
        const fossa = groups.findIndex(group => group.name === "Fossa");
        if (fossa < 0) { reset(); return; }
        const [group] = groups.splice(fossa, 1), firstProvider = groups.findIndex(group => !["Favorites", "Recent"].includes(group.name));
        groups.splice(firstProvider < 0 ? groups.length : firstProvider, 0, group);
        ordered = groups.flatMap(group => group.nodes); rows = groups.flatMap(group => group.nodes.slice(1));
        groups.forEach((group, index) => {
          const heading = group.nodes[0] as BoxRenderable, text = [...visibleNodes(heading)].find(isText)!;
          padding.set(heading, text.y - heading.y); heading.paddingTop = index ? 1 : 0;
        });
        for (const node of original) positions.set(node, node.top);
      }
      // relative offsets preserve the native tree, its reactive updates and row handlers.
      let y = original[0].y - (typeof original[0].top === "number" ? original[0].top : 0);
      for (const node of ordered) {
        const natural = node.y - (typeof node.top === "number" ? node.top : 0), offset = y - natural;
        if (node.top !== offset) node.top = offset;
        y += node.height;
      }
      const next = rows.find(highlighted);
      if (next && next !== selected) { selected = next; reveal(next); }
    },
    commands(): KeymapCommand[] {
      const moves = [["prev", -1], ["next", 1], ["page_up", -10], ["page_down", 10], ["home", -Infinity], ["end", Infinity]] as const;
      return moves.map(([name, delta]) => ({ id: `fossa.model-order.${name}`, bind: context.keymap.shortcuts(`dialog.select.${name}`).join(",") || false,
        run: () => {
          if (!list || list.isDestroyed || !rows.length || rows.some(row => row.isDestroyed)) return false;
          const current = rows.findIndex(highlighted), index = delta === -Infinity ? 0 : delta === Infinity ? rows.length - 1 : Math.abs(delta) === 1 ? (Math.max(0, current) + delta + rows.length) % rows.length : Math.max(0, Math.min(rows.length - 1, current + delta));
          const row = rows[index];
          // use the native row handler so selection, favorites and submit share the same model.
          row.processMouseEvent({ type: "down", button: 0, x: row.x, y: row.y, target: row, modifiers: { shift: false, alt: false, ctrl: false }, propagationStopped: true, defaultPrevented: false, preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent);
          selected = undefined; context.renderer.requestRender();
        },
      }));
    },
  };
}
