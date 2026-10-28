/**
 * Evigauge attribute kit (TypeScript / OpenTelemetry JS)
 * ====================================================
 * There is NO @evigauge/trace npm package. JS/TS instruments via native
 * OpenTelemetry JS exporting OTLP/JSON to Evigauge, and these helpers set the
 * evigauge.* attributes correctly.
 *
 * WIRE CONTRACT (SKILL RULE 0 — violations are dead-lettered silently at ingest):
 *   - Compound fields are JSON STRINGS: setAttribute("evigauge.sources", JSON.stringify({...}))
 *     A nested object becomes an OTLP kvlistValue and kills the whole span.
 *   - consulted/used/dropped are string[] (URLs or stable ids), NOT {id,title} objects.
 *   - query_text/outcome_text are PLAIN strings (never JSON.stringify).
 *   - Only the documented evigauge.* keys exist (extra="forbid"); any other kills the span.
 *
 * Requires: @opentelemetry/api (present in any OTel-instrumented app).
 */
import { trace, context, Span, SpanStatusCode, Tracer } from "@opentelemetry/api";

// Server-validated enums — anything else fails validation.
export type ReasoningRole =
  | "decomposer" | "research" | "analysis" | "critique"
  | "synthesis" | "arbiter" | "retrieval" | "guardrail" | "post_process";
export type NodeType =
  | "decomposer" | "classifier" | "agent" | "guardrail"
  | "post_process" | "retrieval";

export interface EvigaugeEnvelope {
  orgId: string;
  workspaceId: string;   // workspace UUID the dashboard reads
  projectId: string;
  userId?: string;
}

/** Required tenancy envelope — set on EVERY span. */
export function setEvigaugeEnvelope(span: Span, env: EvigaugeEnvelope): void {
  span.setAttribute("evigauge.schema_version", "1.0");
  span.setAttribute("evigauge.org_id", env.orgId);
  span.setAttribute("evigauge.workspace_id", env.workspaceId);
  span.setAttribute("evigauge.project_id", env.projectId);
  if (env.userId) span.setAttribute("evigauge.user_id", env.userId);
  // Keep evigauge.trace_id identical to the OTel trace id.
  span.setAttribute("evigauge.trace_id", span.spanContext().traceId);
}

/** Optional per-user actor attribution (drives per-user alignment flagging). */
export function setEvigaugeEndUser(span: Span, endUser: string): void {
  if (endUser) span.setAttribute("evigauge.end_user", endUser);
}

export interface EvigaugeSources {
  consulted?: string[];   // string ids/URLs, NOT objects
  used?: string[];        // subset actually cited → drives source_authority
  dropped?: string[];
  scores?: Record<string, number>;  // 0..1 per id
}

/** evigauge.sources as a JSON STRING with ONLY the 4 allowed keys. */
export function setEvigaugeSources(span: Span, src: EvigaugeSources): void {
  span.setAttribute("evigauge.sources", JSON.stringify({
    consulted: src.consulted ?? [],
    used: src.used ?? [],
    dropped: src.dropped ?? [],
    scores: src.scores ?? {},
  }));
}

export interface EvigaugeDecision {
  selected?: string;
  rulesFired?: string[];
  scores?: Record<string, number>;
  alternatives?: Record<string, unknown>[];
}

/** evigauge.decision as a JSON STRING with ONLY the 4 allowed keys. */
export function setEvigaugeDecision(span: Span, dec: EvigaugeDecision): void {
  span.setAttribute("evigauge.decision", JSON.stringify({
    rules_fired: dec.rulesFired ?? [],
    scores: dec.scores ?? {},
    selected: dec.selected ?? null,
    alternatives: dec.alternatives ?? [],
  }));
}

export function setEvigaugeReasoning(
  span: Span,
  opts: { role?: ReasoningRole; nodeType?: NodeType; parentReasoningId?: string },
): void {
  if (opts.role) span.setAttribute("evigauge.reasoning_role", opts.role);
  if (opts.nodeType) span.setAttribute("evigauge.node_type", opts.nodeType);
  if (opts.parentReasoningId)
    span.setAttribute("evigauge.parent_reasoning_id", opts.parentReasoningId);
}

/**
 * Capture the user query + final answer — PLAIN strings, never JSON.
 * Put `query` on the EARLIEST span and `outcome` on the LATEST span of the trace
 * (engines take first-non-empty query / last-non-empty outcome). ~16 KB cap.
 */
export function setEvigaugeText(span: Span, text: { query?: string; outcome?: string }): void {
  if (text.query) span.setAttribute("evigauge.query_text", text.query.slice(0, TEXT_CAP));
  if (text.outcome) span.setAttribute("evigauge.outcome_text", text.outcome.slice(0, TEXT_CAP));
}

/** Evigauge truncates text at 16 KB; slicing here keeps what we send == what is stored. */
const TEXT_CAP = 16384;

export interface ChatMessage { role: string; content: string }

/**
 * Render an LLM call's messages into `evigauge.query_text`.
 *
 * ON AN LLM SPAN, query_text IS THE PROMPT — it is what Evigauge versions, evaluates,
 * and measures a cacheable prefix from.
 *
 * DO NOT join the messages' content with a space. Without a role boundary there is
 * nothing separating the authored system prompt from the per-call user content, so
 * Evigauge cannot mask the per-call parts out when deriving the prompt's identity —
 * and EVERY CALL then hashes as its own "prompt". The Prompts page fills with
 * thousands of one-call rows instead of one prompt with a version history.
 */
export function renderPrompt(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role ?? "user"}:\n${m.content ?? ""}`).join("\n\n");
}

/**
 * OPTIONAL — pin a prompt's identity instead of letting Evigauge derive it.
 *
 * `id` makes grouping exact (and lets the `evigauge shipcheck` CI gate match a changed
 * prompt to its baseline without guessing). `label` is the display name.
 *
 * PRIVACY PATH: send `id` + a client-computed `version` and NO query_text at all —
 * you keep prompt versioning and every cost/latency diff, and lose only the
 * text-based prompt-quality checks.
 *
 * NOTE the keys are FLAT: evigauge.prompt_id, NOT evigauge.prompt.id (a dotted
 * evigauge.prompt.* key is not in the envelope and dead-letters the span).
 */
export function setEvigaugePrompt(
  span: Span,
  p: { id?: string; label?: string; version?: string },
): void {
  if (p.id) span.setAttribute("evigauge.prompt_id", p.id);
  if (p.label) span.setAttribute("evigauge.prompt_label", p.label);
  if (p.version) span.setAttribute("evigauge.prompt_version", p.version);
}

/** gen_ai.* — standard OTel GenAI semconv. Cost is inferred server-side if omitted. */
export function setGenAiUsage(
  span: Span,
  usage: {
    system?: string; model?: string; operation?: string;
    inputTokens?: number; outputTokens?: number; finishReason?: string;
    costUsd?: number; pricingVersion?: string;
  },
): void {
  if (usage.system) span.setAttribute("gen_ai.system", usage.system);
  if (usage.model) span.setAttribute("gen_ai.request.model", usage.model);
  if (usage.operation) span.setAttribute("gen_ai.operation.name", usage.operation);
  if (usage.inputTokens != null) span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  if (usage.outputTokens != null) span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  if (usage.finishReason) span.setAttribute("gen_ai.response.finish_reason", usage.finishReason);
  if (usage.costUsd != null) span.setAttribute("evigauge.cost.usd", usage.costUsd);          // flat scalar
  if (usage.pricingVersion) span.setAttribute("evigauge.cost.model_pricing_version", usage.pricingVersion);
}

// --- One-trace-per-request wrapper ------------------------------------------
let _tracer: Tracer | null = null;
let _env: EvigaugeEnvelope | null = null;

export function initEvigauge(env: EvigaugeEnvelope, tracerName = "evigauge"): void {
  _env = env;
  _tracer = trace.getTracer(tracerName);
}

/** Wrap one logical request (= one trace); root span gets the envelope. */
export async function withEvigaugeTrace<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  opts?: { role?: ReasoningRole; nodeType?: NodeType },
): Promise<T> {
  if (!_tracer || !_env) throw new Error("call initEvigauge() first");
  const tracer = _tracer, env = _env;
  return tracer.startActiveSpan(name, async (span) => {
    setEvigaugeEnvelope(span, env);
    if (opts) setEvigaugeReasoning(span, opts);
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Child span inside the current trace (envelope auto-applied). */
export function startEvigaugeSpan(name: string): Span {
  if (!_tracer || !_env) throw new Error("call initEvigauge() first");
  const span = _tracer.startSpan(name, undefined, context.active());
  setEvigaugeEnvelope(span, _env);
  return span;
}
