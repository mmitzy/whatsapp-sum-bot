from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

app = FastAPI()

VERIFY_TOKEN = "ben_is_a_cute_lemur"

@app.get("/webhook")
async def verify(hub_mode: str = "", hub_verify_token: str = "", hub_challenge: str = ""):
    if hub_mode == "subscribe" and hub_verify_token == VERIFY_TOKEN:
        return PlainTextResponse(hub_challenge)
    return PlainTextResponse("Verification failed", status_code=403)

@app.post("/webhook")
async def webhook(request: Request):
    data = await request.json()
    print("Incoming message:", data)
    return {"status": "ok"}
