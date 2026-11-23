// shared by the client and provider. published bundles contain data only.
export function makeCounter(Tokenizer, Template, bundle) {
  if (typeof bundle.chatTemplate !== "string" || !bundle.chatTemplate.length || bundle.chatTemplate.length > 131072 ||
      !Array.isArray(bundle.checks) || !bundle.checks.length || bundle.checks.length > 16 ||
      !bundle.tokenizer || bundle.tokenizer.truncation || bundle.tokenizer.padding ||
      /\b(strftime_now|random)\b/.test(bundle.chatTemplate)) throw Error("Unsupported text counter");
  const tokenizer = new Tokenizer(bundle.tokenizer, {});
  const template = new Template(bundle.chatTemplate);
  function count(body) {
    if (!Array.isArray(body.messages) || body.messages.some(message => Array.isArray(message?.content) &&
        message.content.some(part => part?.type !== "text"))) throw Error("Text counter requires text messages");
    const context = { add_generation_prompt: true };
    for (const key of ["bos_token", "eos_token"]) if (typeof bundle[key] === "string") context[key] = bundle[key];
    for (const key of ["messages", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "response_format"]) {
      if (body[key] != null) context[key] = body[key];
    }
    const prompt = template.render(context);
    if (prompt.length > 8 * 1024 * 1024) throw Error("Prompt too large");
    const size = tokenizer.encode(prompt, { add_special_tokens: false }).ids.length;
    if (!Number.isSafeInteger(size) || size < 1 || size > 0xffffffff) throw Error("Invalid text count");
    return size;
  }
  for (const sample of bundle.checks) {
    if (!Array.isArray(sample.messages) || count(sample) !== sample.tokens) throw Error("Text counter reference count mismatch");
  }
  return count;
}
