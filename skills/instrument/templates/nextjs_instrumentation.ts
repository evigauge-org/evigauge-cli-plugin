/**
 * Evigauge — Next.js instrumentation (Route 0, native OTLP/JSON, SERVER ONLY).
 *
 * Place this file at the PROJECT ROOT as `instrumentation.ts` (Next.js loads it
 * automatically on the server). Never instrument from a client component — the
 * API key must never reach the browser bundle.
 *
 * Install:  npm i @vercel/otel @opentelemetry/api
 *
 * Env (see env.example.block). MUST be http/json — protobuf export returns 415:
 *   EVIGAUGE_INGEST_URL=https://ingest.evigauge.ai
 *   EVIGAUGE_API_KEY=evg_live_…            (server-only secret)
 *
 * After this registers the exporter, enrich spans with the evigauge.* attributes
 * using ./evigauge_attributes.ts (copy it into your project). RULE 0 applies:
 * compound fields are JSON strings; query_text/outcome_text are plain strings.
 */
import { registerOTel, OTLPHttpJsonTraceExporter } from "@vercel/otel";

export function register(): void {
  const base = (process.env.EVIGAUGE_INGEST_URL ?? "https://ingest.evigauge.ai").replace(/\/$/, "");
  registerOTel({
    // service.name becomes evigauge.project_id when a project id header is absent.
    serviceName: process.env.EVIGAUGE_PROJECT_ID || "default",
    traceExporter: new OTLPHttpJsonTraceExporter({
      url: `${base}/v1/traces`,
      headers: {
        "x-evigauge-api-key": process.env.EVIGAUGE_API_KEY ?? "",
      },
    }),
  });
}

/**
 * USAGE in a route handler / server action (NOT a client component):
 *
 *   // app/api/ask/route.ts
 *   import { initEvigauge, withEvigaugeTrace, setEvigaugeText, setGenAiUsage }
 *     from "@/lib/evigauge_attributes";
 *
 *   initEvigauge({
 *     orgId: process.env.EVIGAUGE_ORG_ID!,
 *     workspaceId: process.env.EVIGAUGE_WORKSPACE_ID!,
 *     projectId: process.env.EVIGAUGE_PROJECT_ID ?? "default",
 *   });
 *
 *   export async function POST(req: Request) {
 *     const { question } = await req.json();
 *     const answer = await withEvigaugeTrace("chat.turn", async (span) => {
 *       setEvigaugeText(span, { query: question });      // earliest span
 *       const res = await callYourLLM(question);
 *       setGenAiUsage(span, {
 *         system: "openai", model: "gpt-4o",
 *         inputTokens: res.usage.prompt_tokens,
 *         outputTokens: res.usage.completion_tokens,
 *       });
 *       setEvigaugeText(span, { outcome: res.text });     // final answer on same/last span
 *       return res.text;
 *     }, { nodeType: "agent" });
 *     return Response.json({ answer });
 *   }
 */
