/** Parsed Claude Messages API response classification; no retry or dispatch authority. */
type RecordValue = Record<string, unknown>;
type ProgressKind = "start" | "text" | "tool" | "thinking" | "fallback" | "terminal-signal"
  | "terminal" | "error" | "unknown";
type Progress = { kind: ProgressKind; eventType: string; index: number | null };
type BlockKind = "text" | "tool" | "thinking" | "fallback" | "unknown";

const STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use",
  "pause_turn", "refusal", "model_context_window_exceeded"]);
const REFUSAL_CATEGORIES = new Set(["cyber", "bio", "frontier_llm", "reasoning_extraction",
  "general_harms"]);
const value = (input: unknown): RecordValue | null =>
  input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as RecordValue : null;
const nonempty = (input: unknown): string | null =>
  typeof input === "string" && input.length > 0 ? input : null;
const index = (event: RecordValue): number | null =>
  Number.isSafeInteger(event.index) && (event.index as number) >= 0 ? event.index as number : null;
const blockKind = (block: RecordValue | null): BlockKind =>
  block?.type === "text" ? "text" : block?.type === "thinking"
    || block?.type === "redacted_thinking" ? "thinking"
      : block?.type === "tool_use" || block?.type === "server_tool_use" ? "tool"
        : block?.type === "fallback" ? "fallback" : "unknown";

function progressOf(event: RecordValue): Progress {
  const type = nonempty(event.type) ?? "unknown";
  let kind: ProgressKind = "unknown";
  if (type === "message_start") kind = "start";
  else if (type === "message_stop") kind = "terminal";
  else if (type === "error") kind = "error";
  else if (type === "message_delta") kind = "terminal-signal";
  else if (type === "content_block_start") {
    kind = blockKind(value(event.content_block));
  } else if (type === "content_block_delta") {
    const delta = value(event.delta);
    if (delta?.type === "text_delta") kind = "text";
    else if (delta?.type === "thinking_delta" || delta?.type === "signature_delta") kind = "thinking";
    else if (delta?.type === "input_json_delta") kind = "tool";
  }
  return { kind, eventType: type, index: index(event) };
}

function streamStop(events: RecordValue[]): RecordValue | null {
  const stop: RecordValue = {};
  for (const event of events) {
    if (event.type !== "message_delta") continue;
    const delta = value(event.delta);
    if (nonempty(delta?.stop_reason)) stop.stop_reason = delta?.stop_reason;
    if (value(delta?.stop_details)) stop.stop_details = delta?.stop_details;
  }
  return Object.keys(stop).length ? stop : null;
}

function exposedModel(response: RecordValue | null, events: RecordValue[], terminal: boolean) {
  if (!terminal) return { id: null, source: "unknown" };
  const direct = nonempty(response?.model);
  if (direct) return { id: direct, source: "response.model" };
  if (Array.isArray(response?.content)) {
    for (let i = response.content.length - 1; i >= 0; i--) {
      const block = value(response.content[i]);
      if (block?.type === "fallback") {
        const to = nonempty(value(block.to)?.model);
        if (to) return { id: to, source: "response.content.fallback.to.model" };
      }
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const block = value(event.content_block);
    if (event.type === "content_block_start" && block?.type === "fallback") {
      const to = nonempty(value(block.to)?.model);
      if (to) return { id: to, source: "stream.fallback.to.model" };
    }
  }
  const started = events.find(event => event.type === "message_start");
  return { id: nonempty(value(started?.message)?.model),
    source: nonempty(value(started?.message)?.model) ? "stream.message_start.model" : "unknown" };
}

/** The caller must bind response/events to the same trusted provider invocation. */
export function normalizeClaudeModelResponse(input: {
  requestedModel: string;
  response?: unknown;
  streamEvents?: unknown[];
}) {
  if (!nonempty(input?.requestedModel) || input.response !== undefined && !value(input.response)
    || input.streamEvents !== undefined && !Array.isArray(input.streamEvents))
    throw new TypeError("Invalid Claude response normalization input");
  const response = value(input.response);
  const events = (input.streamEvents ?? []).map(event => {
    const parsed = value(event);
    if (!parsed) throw new TypeError("Invalid Claude stream event");
    return parsed;
  });
  const sawMessageStop = events.some(event => event.type === "message_stop");
  const stop = response ? response : sawMessageStop ? streamStop(events) : null;
  const stopReason = nonempty(stop?.stop_reason);
  const terminal = stopReason !== null && (response !== null || sawMessageStop);
  const status = terminal ? "terminal" : events.some(event => event.type === "error")
    ? "error" : events.length ? "partial-stream" : "unknown";
  const refusal = terminal && stopReason === "refusal";
  const details = value(response?.stop_details) ?? value(stop?.stop_details);
  const category = refusal ? nonempty(details?.category) : null;
  const blocks = Array.isArray(response?.content) ? response.content : null;
  const rawText = blocks
    ? blocks.map(block => value(block)).filter(block => block?.type === "text")
      .map(block => typeof block?.text === "string" ? block.text : "").join("")
    : events.filter(event => event.type === "content_block_delta"
      && value(event.delta)?.type === "text_delta")
      .map(event => typeof value(event.delta)?.text === "string"
        ? value(event.delta)?.text as string : "").join("");
  const model = exposedModel(response, events, terminal);
  const streamUsage: RecordValue = {};
  let streamUsageSource = "unknown";
  for (const event of events) {
    const next = event.type === "message_start"
      ? value(value(event.message)?.usage)
      : event.type === "message_delta" ? value(event.usage) : null;
    if (next) {
      Object.assign(streamUsage, next);
      streamUsageSource = streamUsageSource === "unknown"
        ? event.type === "message_start" ? "stream.message_start.usage"
          : "stream.message_delta.usage"
        : "stream.merged.usage";
    }
  }
  const responseUsage = value(response?.usage);
  const usage = responseUsage ?? (streamUsageSource === "unknown" ? null : streamUsage);
  const blockFallback = blocks?.some(block => value(block)?.type === "fallback") ?? false;
  const streamFallback = events.some(event => event.type === "content_block_start"
    && value(event.content_block)?.type === "fallback");
  const usageFallback = Array.isArray(usage?.iterations)
    && usage.iterations.some(item => value(item)?.type === "fallback_message");
  const providerFallbackObserved = blockFallback || streamFallback || usageFallback;
  return {
    status,
    progress: events.map(progressOf),
    content: blocks?.map((block, position) => ({
      index: position, type: nonempty(value(block)?.type) ?? "unknown", kind: blockKind(value(block)),
    })) ?? [],
    stop: { reason: stopReason, recognized: stopReason === null ? null : STOP_REASONS.has(stopReason),
      kind: refusal ? "refusal" : stopReason === "max_tokens"
        || stopReason === "model_context_window_exceeded" ? "truncated"
          : terminal && STOP_REASONS.has(stopReason) ? "terminal" : "unknown",
      category, categoryRecognized: category === null ? null : REFUSAL_CATEGORIES.has(category) },
    display: { text: refusal ? "" : rawText, provisional: !terminal },
    continuationBlocks: terminal && !refusal && blocks ? structuredClone(blocks) : null,
    model: { requested: input.requestedModel, exposed: model.id, source: model.source,
      mismatch: model.id === null ? null : model.id !== input.requestedModel,
      hiddenBackend: "unknown", admitted: false },
    usage: { value: usage === null ? null : structuredClone(usage),
      source: responseUsage ? "response.usage" : streamUsageSource,
      admitted: false },
    fallback: { providerPossible: providerFallbackObserved ? true : "unknown",
      providerObserved: providerFallbackObserved, selfRetryPerformed: false },
    rawResponse: response === null ? null : structuredClone(response),
    rawStreamEvents: structuredClone(events),
    executionAuthorized: false,
  };
}
