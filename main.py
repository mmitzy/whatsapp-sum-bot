# main.py
import os
import sys
import json
import re
import urllib.request
import urllib.error

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    sys.stderr.reconfigure(encoding="utf-8", errors="strict")
except Exception:
    pass

def clamp_to_chars_nice(text: str, max_chars: int) -> str:
    text = (text or "").strip()
    if not max_chars or len(text) <= max_chars:
        return text
    cut = text[: max_chars - 1]
    last_space = cut.rfind(" ")
    if last_space > 120:
        cut = cut[:last_space]
    return cut.rstrip() + "…"


def _http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def list_available_models(api_key: str) -> list[str]:
    """
    Calls the REST ListModels endpoint to get models available for this key.
    Returns a list of model names like "models/gemini-2.5-flash".
    """
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    data = _http_get_json(url)
    models = data.get("models", []) or []
    out = []
    for m in models:
        name = m.get("name")
        if name:
            out.append(name)
    return out


def pick_model(api_key: str, preferred: str | None) -> str:
    """
    Picks a model name to use.
    - If preferred is set and exists in ListModels -> use it
    - Else pick the newest Flash-ish model we can find
    - Else fall back to the first model from the list
    """
    preferred = (preferred or "").strip() or None
    models = list_available_models(api_key)

    # Normalize preferred: allow "gemini-2.5-flash" OR "models/gemini-2.5-flash"
    if preferred:
        pref_full = preferred if preferred.startswith("models/") else f"models/{preferred}"
        if pref_full in models:
            return preferred.replace("models/", "")
        # If user provided a full name but models returns same, handle gracefully
        if preferred in models and preferred.startswith("models/"):
            return preferred.replace("models/", "")

    # Heuristic: choose Flash models first, try to prefer 2.5 then 2.0 then anything flash
    # We'll sort by "version-ish" numbers if present.
    flash = [m for m in models if "flash" in m.lower()]
    if flash:
        def score(name: str) -> tuple:
            # name like "models/gemini-2.5-flash" or "models/gemini-3-flash-preview"
            n = name.lower()
            # Extract numbers for rough ordering
            nums = re.findall(r"(\d+)\.(\d+)|(\d+)", n)
            # flatten into ints
            extracted = []
            for g in nums:
                if g[0] and g[1]:
                    extracted.append(int(g[0]))
                    extracted.append(int(g[1]))
                elif g[2]:
                    extracted.append(int(g[2]))
            # Prefer stable over preview
            is_preview = ("preview" in n) or ("exp" in n) or ("experimental" in n)
            # Prefer flash over flash-lite? (both ok)
            is_lite = ("lite" in n)
            # Higher numbers first
            return (
                1 if not is_preview else 0,
                1 if not is_lite else 0,
                extracted  # compare lexicographically
            )

        flash_sorted = sorted(flash, key=score, reverse=True)
        return flash_sorted[0].replace("models/", "")

    # If no flash, just use first available model
    if models:
        return models[0].replace("models/", "")

    raise RuntimeError("No models available for this API key (ListModels returned empty).")


def summarize_with_gemini(transcript: str, interval_label: str, max_chars: int) -> str:
    # Use the official Google Gen AI SDK
    # pip install google-genai
    from google import genai  # type: ignore

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing GEMINI_API_KEY environment variable")

    preferred_model = os.environ.get("GEMINI_MODEL")  # optional
    client = genai.Client(api_key=api_key)

    prompt = f"""
You are a WhatsApp group chat summarizer called "Ben Kirk/Agent Ben".
Sometimes you will be used as a blackjack dealer bot.

IMPORTANT: Write the entire summary in Hebrew.
Use natural, informal Hebrew suitable for WhatsApp.

Task:
Summarize what happened in this group chat during the last {interval_label}.

Output requirements:
- 5–10 concise bullet points
- Then: "Open questions / next actions" (0–5 bullets)
- Then: "Notable quotes" (0–3 short quotes) ONLY if genuinely funny/important
- Do not invent facts. If unclear, say so briefly.
- Group by topic when there are multiple topics.
- Keep the entire output under {max_chars} characters.

Chat log:
{transcript}
""".strip()

    # Adaptive model selection:
    # 1) Try preferred (if set) OR heuristic-picked model
    # 2) If 404 NOT_FOUND -> refresh model list and try next best flash model
    model = pick_model(api_key, preferred_model)

    tried = []
    last_err = None

    # We’ll attempt up to 3 candidates:
    # - chosen model
    # - next 2 flash candidates (if available)
    candidates = [model]

    try:
        all_models = list_available_models(api_key)
        flash = [m.replace("models/", "") for m in all_models if "flash" in m.lower()]
        # Put newer-ish first using the same picker by repeatedly removing selected
        # (simple approach: ensure model first, then append other flash models)
        for m in flash:
            if m not in candidates:
                candidates.append(m)
    except Exception:
        # If ListModels fails for any reason, we still have candidates=[model]
        pass

    candidates = candidates[:3]

    for m in candidates:
        if m in tried:
            continue
        tried.append(m)

        try:
            resp = client.models.generate_content(
                model=m,
                contents=prompt
            )

            text = getattr(resp, "text", "") or ""
            if not isinstance(text, str):
                text = str(text)
            text = text.strip()

            if not text:
                text = "No summary returned."
            return clamp_to_chars_nice(text, max_chars)

        except Exception as e:
            last_err = e
            msg = str(e)

            # Detect the specific "model not found" / 404 situation and try next candidate
            # Different environments surface this slightly differently, so we match broadly.
            if "404" in msg or "NOT_FOUND" in msg or "is not found" in msg or "model" in msg.lower() and "not found" in msg.lower():
                continue
            # For non-404 errors (quota, auth, etc.) stop immediately.
            raise

    # If we get here, all candidates failed (likely all 404s)
    raise RuntimeError(f"All candidate models failed. Tried: {tried}. Last error: {last_err}")


def main():
    # If you already have other CLI modes, keep them.
    if "--summarize" not in sys.argv:
        # Existing behavior (if any) could run here.
        # For safety, we do nothing.
        return

    raw = sys.stdin.read()
    payload = json.loads(raw or "{}")

    transcript = payload.get("transcript", "") or ""
    interval_label = payload.get("interval_label", "unknown")
    try:
        max_chars = int(payload.get("max_chars", 1500))
    except Exception:
        max_chars = 1500

    # Basic guardrails
    transcript = transcript.strip()
    if not transcript:
        print("Nothing to summarize (no transcript).")
        return

    try:
        summary = summarize_with_gemini(transcript, interval_label, max_chars)
        print(summary)
    except Exception as e:
        # Send errors to stderr so the Node bridge rejects and you can fallback in JS.
        print(f"Summarizer error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
