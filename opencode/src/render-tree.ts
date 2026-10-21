import type { Renderable, TextRenderable } from "@opentui/core";

export const isText = (node: Renderable): node is TextRenderable => "plainText" in node && typeof node.plainText === "string";
export const textOf = (node: Renderable) => isText(node) ? node.plainText : "";

export function* visibleNodes(root: Renderable): Generator<Renderable> {
  if (root.isDestroyed || !root.visible || root.id.startsWith("fossa-") || root.width <= 0 || root.height <= 0) return;
  yield root;
  for (const child of root.getChildren()) yield* visibleNodes(child);
}
