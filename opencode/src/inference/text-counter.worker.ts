import { Tokenizer } from "@huggingface/tokenizers";
import { Template } from "@huggingface/jinja";
// @ts-expect-error shared javascript reference implementation.
import { makeCounter } from "./text-counter-core.js";

let count: ((body: unknown) => number) | undefined;
self.onmessage = event => {
  try {
    if (event.data.bytes) count = makeCounter(Tokenizer, Template, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(event.data.bytes)));
    self.postMessage({ id: event.data.id, tokens: count!(event.data.body) });
  } catch {
    self.postMessage({ id: event.data.id });
  }
};
