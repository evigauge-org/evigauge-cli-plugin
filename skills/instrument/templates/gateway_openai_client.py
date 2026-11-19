"""Evigauge AI Gateway — trace LLM calls by changing ONE line (Route 3).

No tracing SDK, no OpenTelemetry. Point your existing OpenAI-compatible client at
the Evigauge Gateway; it forwards byte-for-byte to the provider and captures the
call (prompt, response, tokens, latency, cost) in the background.

Works with the OpenAI and Anthropic SDKs, OpenRouter, LangChain, LiteLLM,
LangFuse, the Vercel AI SDK / Next.js, and plain requests/httpx — anything that
takes a base URL.

Env (placeholders in .env.example; real values in a gitignored .env):
  EVIGAUGE_GATEWAY_URL = https://gateway.evigauge.ai/v1
  EVIGAUGE_API_KEY     = evg_live_...     # your Evigauge key (tenancy/auth)
  EVIGAUGE_PROJECT_ID  = checkout-bot     # project slug
  EVIGAUGE_APP         = checkout-bot     # one-app-per-project fingerprint
  OPENAI_API_KEY       = sk-...           # BYOK provider key (or connect in dashboard)
"""
import os

from openai import OpenAI


def gateway_client() -> OpenAI:
    """An OpenAI client that traces every call through Evigauge.

    - `api_key` is your EVIGAUGE key → sent as `Authorization: Bearer evg_...`
      (that is how the Gateway identifies your workspace).
    - `x-provider-key` is your real provider key (BYOK). Omit it only if you have
      connected the provider in the Evigauge dashboard; otherwise the Gateway
      returns 412 (no key to forward with).
    - `x-evigauge-app` locks this project to THIS application. A second app sending
      to the same project is blocked (project_app_conflict) — give each app a
      distinct name. All of one app's agents share the name.
    """
    headers = {
        "x-evigauge-project-id": os.environ.get("EVIGAUGE_PROJECT_ID", "default"),
        "x-evigauge-app": os.environ.get("EVIGAUGE_APP", ""),
    }
    provider_key = os.environ.get("OPENAI_API_KEY")
    if provider_key:
        headers["x-provider-key"] = provider_key   # BYOK; or connect in the dashboard

    return OpenAI(
        base_url=os.environ.get("EVIGAUGE_GATEWAY_URL", "https://gateway.evigauge.ai/v1"),
        api_key=os.environ["EVIGAUGE_API_KEY"],     # the EVIGAUGE key, not the provider key
        default_headers={k: v for k, v in headers.items() if v},
    )


if __name__ == "__main__":
    client = gateway_client()
    # Unchanged call site — it is now traced in Evigauge.
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "Say hi in five words."}],
    )
    print(resp.choices[0].message.content)
