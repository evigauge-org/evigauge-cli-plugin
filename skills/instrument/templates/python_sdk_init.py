"""Evigauge — evigauge-trace SDK bootstrap (Route 2, greenfield Python).

Install:  pip install --upgrade --pre "evigauge-trace>=0.1.0a12"
          # --pre is REQUIRED (every release is an alpha). <0.1.0a12 dead-letters
          # every auto-instrumented span — do not pin below it.

Call init() ONCE, as early as possible in process startup (before the LLM
clients you want auto-instrumented are used). The agent adapting this template
should place the call in the real entrypoint (e.g. main.py / app factory).
"""
import os

from evigauge.trace import init


def init_evigauge() -> None:
    init(
        org_id=os.environ["EVIGAUGE_ORG_ID"],
        workspace_id=os.environ["EVIGAUGE_WORKSPACE_ID"],
        project_id=os.environ.get("EVIGAUGE_PROJECT_ID", "default"),
        # The ingest host. For transport="direct" spans POST straight here.
        backend_url=os.environ["EVIGAUGE_INGEST_URL"],
        api_key=os.environ["EVIGAUGE_API_KEY"],
        # "direct" = no collector, no gRPC. Or set EVIGAUGE_TRANSPORT=direct in env.
        transport=os.environ.get("EVIGAUGE_TRANSPORT", "direct"),
        auto_instrument=True,
        # Degrade gracefully instead of crashing app startup if the exporter or
        # WAL can't initialise. Flip to False if you want init failures to raise.
        fail_open=True,
    )


# ---------------------------------------------------------------------------
# Enriching spans with the evigauge.* intelligence attributes (optional).
#
# Auto-instrument alone gives you spans, latency, errors, cost, and fleet
# topology. To light up the reasoning/reliability/sources engines, attach the
# evigauge.* attributes to the ACTIVE span. Every value obeys SKILL RULE 0:
#   - compound fields (sources/decision) are json.dumps STRINGS, never dicts
#   - query_text/outcome_text are PLAIN strings, never json.dumps
# ---------------------------------------------------------------------------
import json

from opentelemetry import trace as _ot_trace


def render_prompt(messages: list[dict]) -> str:
    """Render an LLM call's messages into `evigauge.query_text`.

    ON AN LLM SPAN, query_text IS THE PROMPT — it is what Evigauge versions, evaluates,
    and measures a cacheable prefix from.

    DO NOT do `" ".join(m["content"] for m in messages)`. Without a role boundary
    there is nothing separating the authored system prompt from the per-call user
    content, so Evigauge cannot mask the per-call parts out when deriving the prompt's
    identity — and EVERY CALL then hashes as its own "prompt". The Prompts page fills
    with thousands of one-call rows instead of one prompt with a version history.

    (evigauge-trace >= 0.1.0a13 does this for you on the auto-instrument path. You need
    this helper when you render the text yourself.)
    """
    return "\n\n".join(
        f"{m.get('role', 'user')}:\n{m.get('content', '')}" for m in messages
    )


def annotate_current_span(
    *,
    query_text: str | None = None,      # put on the EARLIEST span (user question)
    outcome_text: str | None = None,    # put on the LATEST span (final answer)
    reasoning_role: str | None = None,  # decomposer|research|analysis|critique|
                                        # synthesis|arbiter|retrieval|guardrail|post_process
    node_type: str | None = None,       # decomposer|classifier|agent|guardrail|
                                        # post_process|retrieval
    end_user: str | None = None,        # employee id/email → per-user alignment
    sources: dict | None = None,        # {consulted:[str], used:[str], dropped:[str], scores:{id:0..1}}
    decision: dict | None = None,       # {rules_fired:[str], scores:{}, selected:str, alternatives:[]}
    prompt_id: str | None = None,       # OPTIONAL — pin the prompt identity (see render_prompt)
    prompt_label: str | None = None,    # OPTIONAL — display name instead of a hash
    prompt_version: str | None = None,  # OPTIONAL — client-computed hash (no-text privacy path)
) -> None:
    span = _ot_trace.get_current_span()
    if span is None:
        return
    if query_text:
        span.set_attribute("evigauge.query_text", query_text[:16384])    # PLAIN string
    if outcome_text:
        span.set_attribute("evigauge.outcome_text", outcome_text[:16384])  # PLAIN string
    # Flat, un-dotted keys. `evigauge.prompt.id` is NOT in the envelope and would
    # dead-letter the whole span.
    if prompt_id:
        span.set_attribute("evigauge.prompt_id", prompt_id)
    if prompt_label:
        span.set_attribute("evigauge.prompt_label", prompt_label)
    if prompt_version:
        span.set_attribute("evigauge.prompt_version", prompt_version)
    if reasoning_role:
        span.set_attribute("evigauge.reasoning_role", reasoning_role)
    if node_type:
        span.set_attribute("evigauge.node_type", node_type)
    if end_user:
        span.set_attribute("evigauge.end_user", end_user)
    if sources is not None:
        # JSON STRING — a dict here would dead-letter the whole span.
        span.set_attribute("evigauge.sources", json.dumps({
            "consulted": sources.get("consulted", []),   # list[str], NOT objects
            "used": sources.get("used", []),
            "dropped": sources.get("dropped", []),
            "scores": sources.get("scores", {}),
        }))
    if decision is not None:
        span.set_attribute("evigauge.decision", json.dumps({
            "rules_fired": decision.get("rules_fired", []),
            "scores": decision.get("scores", {}),
            "selected": decision.get("selected"),
            "alternatives": decision.get("alternatives", []),
        }))
