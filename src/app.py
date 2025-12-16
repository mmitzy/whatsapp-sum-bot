from functools import lru_cache
from fastapi import FastAPI, Request, Depends
from typing import Annotated
from fastapi.responses import PlainTextResponse, JSONResponse, RedirectResponse
from .config import Settings

app = FastAPI()


# VERIFY_TOKEN =  #should not be visible to everybody maybe using config would be better
@lru_cache
def get_settings():
    return Settings() 

@app.get("/")
async def root():
    # This redirects anyone visiting '/' straight to '/docs
    return RedirectResponse(url="/docs")
# Verify webhook endpoint
@app.get("/webhook")
def verify_webhook(
    request: Request, settings: Annotated[Settings, Depends(get_settings)]
):
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    print("💡 Verification attempt")
    print("mode:", mode)
    print("token:", token)
    print("challenge:", challenge)

    if mode == "subscribe" and token == settings.VERIFY_TOKEN:
        return PlainTextResponse(challenge)

    return PlainTextResponse("Verification failed", status_code=403)


# Handle incoming webhook messages
@app.post("/webhook")
async def receive_webhook(request: Request):
    data = await request.json()
    print("📩 Incoming message webhook:")
    print(data)

    return JSONResponse({"status": "received"})
