from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, JSONResponse

app = FastAPI()

# Make sure we match this token in meta
VERIFY_TOKEN = "ben_is_a_cute_lemur"

# Verify webhook endpoint
@app.get("/webhook")
async def verify_webhook(request: Request):
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    print("💡 Verification attempt")
    print("mode:", mode)
    print("token:", token)
    print("challenge:", challenge)

    if mode == "subscribe" and token == VERIFY_TOKEN:
        return PlainTextResponse(challenge)

    return PlainTextResponse("Verification failed", status_code=403)

# Handle incoming webhook messages
@app.post("/webhook")
async def receive_webhook(request: Request):
    data = await request.json()
    print("📩 Incoming message webhook:")
    print(data)

    return JSONResponse({"status": "received"})
