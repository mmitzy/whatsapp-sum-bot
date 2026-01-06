# main.py
import os
import sys
import json

def clamp_to_chars_nice(text: str, max_chars: int) -> str:
  text = (text or "").strip()
  if not max_chars or len(text) <= max_chars:
    return text
  cut = text[: max_chars - 1]
  last_space = cut.rfind(" ")
  if last_space > 120:
    cut = cut[:last_space]
  return cut.rstrip() + "…"

def summarize_with_gemini(transcript: str, interval_label: str, max_chars: int) -> str:
  # Google Gen AI SDK (google-genai)
  from google import genai  # type: ignore

  api_key = os.environ.get("GEMINI_API_KEY")
  if not api_key:
    raise RuntimeError("Missing GEMINI_API_KEY environment variable")

  client = genai.Client(api_key=api_key)

  prompt = f"""
You are a WhatsApp group chat summarizer.

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

  # Model: Gemini 1.5 Flash (free tier friendly)
  resp = client.models.generate_content(
    model="gemini-1.5-flash",
    contents=prompt
  )

  # SDK exposes resp.text in examples/docs
  text = getattr(resp, "text", "") or ""
  text = text.strip() if isinstance(text, str) else str(text)

  return clamp_to_chars_nice(text, max_chars)

def main():
  if "--summarize" not in sys.argv:
    # Your existing behavior
    return

  raw = sys.stdin.read()
  payload = json.loads(raw or "{}")

  transcript = payload.get("transcript", "") or ""
  interval_label = payload.get("interval_label", "unknown")
  max_chars = int(payload.get("max_chars", 1500))

  # basic guardrails
  if not transcript.strip():
    print("Nothing to summarize (no transcript).")
    return

  try:
    summary = summarize_with_gemini(transcript, interval_label, max_chars)
    print(summary)
  except Exception as e:
    # IMPORTANT: send errors to stderr so JS can show fallback
    print(f"Summarizer error: {e}", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
  main()
