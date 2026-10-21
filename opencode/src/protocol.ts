type Message = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown; name?: unknown; reasoning_content?: unknown; refusal?: unknown };
const fields = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "stream", "reasoning_effort", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "stop", "response_format", "stream_options", "store", "n", "logprobs"]);

export function inputBound(body: { messages: unknown; tools?: unknown }, contextTokens?: number) {
  // reserve the full context for image requests until upstream exposes a trustworthy vision tokenizer.
  if (contextTokens && Array.isArray(body.messages) && body.messages.some(message => Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "image_url"))) return contextTokens;
  const bytes = Buffer.byteLength(JSON.stringify(body.messages)) + (body.tools ? Buffer.byteLength(JSON.stringify(body.tools)) + 32 : 0) + 512;
  return Math.min(bytes, contextTokens ?? Number.MAX_SAFE_INTEGER);
}
export function validateBody(value: unknown, booking: { maxInput: number; maxOutput: number; claimEnd: number }, config: { model: string; speed_tps: number; context_tokens: number; max_input_bound?: number; output_tokens: number; tools: boolean; input?: string[]; effort?: string[] }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid request body");
  const body = value as Record<string, any>;
  if (body.model !== config.model) throw Error("Request model does not match the booked model");
  if (!Array.isArray(body.messages) || !body.messages.length) throw Error("Request must contain messages");
  const unsupported = Object.keys(body).filter(key => !fields.has(key));
  if (unsupported.length) throw Error(`Unsupported request fields: ${unsupported.join(", ")}`);
  if (body.store != null && body.store !== false) throw Error("Request storage is not supported; use store: false");
  if (body.n != null && body.n !== 1) throw Error("Only n: 1 is supported");
  if (body.logprobs != null && body.logprobs !== false) throw Error("Log probabilities are not supported");
  if (body.stream != null && typeof body.stream !== "boolean" || body.reasoning_effort != null && !(config.effort ?? ["none", "low", "medium", "high", "xhigh", "max"]).includes(body.reasoning_effort)) throw Error("Invalid generation settings");
  const toolIds = new Set<string>();
  for (const message of body.messages as Message[]) {
    if (!message || typeof message !== "object" || Array.isArray(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role)) || Object.keys(message).some(key => !["role", "content", "tool_calls", "tool_call_id", "name", "reasoning_content", "refusal"].includes(key))) throw Error("Invalid message");
    if (message.content !== null && message.content !== undefined && typeof message.content !== "string") {
      if (!Array.isArray(message.content)) throw Error("Invalid message content");
      for (const part of message.content) {
        if (part?.type === "image_url") {
          if (!config.input?.includes("image")) throw Error(`${config.model} does not support images. Choose an image-capable model before sending.`);
          const image = part.image_url;
          if (message.role !== "user" || !image || typeof image.url !== "string" || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url) || image.detail !== undefined && !["auto", "low", "high"].includes(image.detail) || Object.keys(image).some(key => !["url", "detail"].includes(key)) || Object.keys(part).some(key => !["type", "image_url"].includes(key))) throw Error("Use an attached PNG, JPEG, WebP, or GIF image");
        } else if (!(part?.type === "text" && typeof part.text === "string" && Object.keys(part).every(key => key === "type" || key === "text")) && !(message.role === "assistant" && part?.type === "refusal" && typeof part.refusal === "string" && Object.keys(part).every(key => key === "type" || key === "refusal"))) throw Error("Unsupported content type");
      }
    }
    if (message.refusal !== undefined && (message.role !== "assistant" || message.refusal !== null && typeof message.refusal !== "string")) throw Error("Invalid refusal history");
    if (message.reasoning_content !== undefined && (message.role !== "assistant" || typeof message.reasoning_content !== "string")) throw Error("Invalid reasoning history");
    if (message.tool_calls !== undefined) {
      if (!config.tools || message.role !== "assistant" || !Array.isArray(message.tool_calls)) throw Error("Invalid tool calls");
      for (const call of message.tool_calls) {
        if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id || typeof call.function?.name !== "string" || typeof call.function?.arguments !== "string" || toolIds.has(call.id)) throw Error("Invalid tool call");
        toolIds.add(call.id);
      }
    }
    if (message.role === "tool") {
      if (!config.tools || typeof message.tool_call_id !== "string" || !toolIds.delete(message.tool_call_id) || typeof message.content !== "string" && !Array.isArray(message.content)) throw Error("Tool result has no matching tool call");
    } else if (message.tool_call_id !== undefined) throw Error("Invalid tool result");
  }
  if (body.tools !== undefined && (!config.tools || !Array.isArray(body.tools) || body.tools.length > 512 || !body.tools.every((tool: any) => tool?.type === "function" && typeof tool.function?.name === "string" && tool.function.name.length <= 128 && (tool.function.parameters === undefined || tool.function.parameters && typeof tool.function.parameters === "object" && !Array.isArray(tool.function.parameters))))) throw Error("Invalid tool definitions");
  if (body.tool_choice !== undefined && !["auto", "none", "required"].includes(body.tool_choice) && !(body.tool_choice?.type === "function" && typeof body.tool_choice.function?.name === "string")) throw Error("Invalid tool choice");
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") throw Error("Invalid parallel tool setting");
  for (const [key, min, max] of [["temperature", 0, 2], ["top_p", 0, 1], ["frequency_penalty", -2, 2], ["presence_penalty", -2, 2]] as const) if (body[key] != null && (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < min || body[key] > max)) throw Error("Invalid sampling setting");
  if (body.seed != null && !Number.isSafeInteger(body.seed)) throw Error("Invalid seed");
  if (body.stop != null && typeof body.stop !== "string" && !(Array.isArray(body.stop) && body.stop.length <= 4 && body.stop.every((item: unknown) => typeof item === "string"))) throw Error("Invalid stop sequences");
  if (body.stream_options != null && (body.stream !== true || typeof body.stream_options !== "object" || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(key => !["include_usage", "include_obfuscation"].includes(key) || typeof body.stream_options[key] !== "boolean"))) throw Error("Invalid stream options");
  const max = body.max_tokens ?? body.max_completion_tokens ?? Math.min(booking.maxOutput, config.output_tokens);
  if (!Number.isSafeInteger(max) || max < 1 || max > booking.maxOutput || max > config.output_tokens || body.max_tokens != null && body.max_completion_tokens != null) throw Error("Output limit exceeded");
  if (inputBound(body as { messages: unknown }, config.context_tokens) > booking.maxInput || booking.maxInput > (config.max_input_bound ?? config.context_tokens)) throw Error("Input limit exceeded");
  if (Date.now() / 1000 + Math.ceil(max / Math.max(1, config.speed_tps)) + 5 >= booking.claimEnd) throw Error("Booking deadline too short");
  return max;
}
