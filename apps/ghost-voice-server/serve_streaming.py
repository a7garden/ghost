"""Owned loopback media service; Ghost Host remains the only turn authority."""

import argparse
from contextlib import asynccontextmanager
import hmac
import json
import os
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import asyncio

from host_voice_bridge import HostVoiceBridge, VoiceHostError
from remote_speech import RemoteSpeech
from speech_contract import SpeechError
from streaming import (
    ConversationTarget,
    INSTALLATION_PATTERN,
    MediaContext,
    MediaEvidence,
    create_streaming_router,
)


class GatewayAuthority:
    """Per-effect device authority via the gateway revocation source.

    The gateway is the only process that knows the device registry, so every
    Host transcript submission and playback start asks it, over authenticated
    loopback, immediately before dispatch — bound to the session's exact
    admission start_id so an old call can never borrow a newer call's
    authority. The whole exchange runs under one absolute deadline with a
    256-byte streamed read (no per-read trickle forever); transport, deadline,
    and shape failures raise: callers treat that as unknown authority and
    never dispatch blind.
    """

    TOTAL_SECONDS = 3.0
    MAX_RESPONSE_BYTES = 256

    def __init__(self, listen_origin: str, public_origin: str, control_token: str):
        parsed = urlsplit(listen_origin)
        if (parsed.scheme != "http"
                or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
                or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError("gateway_listen_must_be_loopback_http")
        public = urlsplit(public_origin)
        if public.scheme != "https" or not public.hostname or public.username or public.password \
                or public.path not in ("", "/") or public.query or public.fragment:
            raise ValueError("gateway_origin_must_be_public_https")
        self._client = httpx.AsyncClient(
            base_url=f"http://{parsed.netloc}",
            timeout=httpx.Timeout(3.5),
            trust_env=False,
            follow_redirects=False,
            headers={
                "Authorization": "Bearer " + control_token,
                "X-Ghost-CSRF": control_token,
                "Host": public.netloc,
                "Content-Type": "application/json",
            },
        )

    async def close(self):
        await self._client.aclose()

    async def __call__(self, installation: str, start_id: str) -> bool:
        async def once() -> bytes:
            async with self._client.stream(
                "POST", "/internal/v1/voice/authority",
                json={"device_id": installation, "start_id": start_id},
            ) as response:
                if response.status_code != 200:
                    raise ValueError("voice_authority_unknown")
                parts: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > self.MAX_RESPONSE_BYTES:
                        raise ValueError("voice_authority_invalid")
                    parts.append(chunk)
                return b"".join(parts)

        try:
            body = await asyncio.wait_for(once(), timeout=self.TOTAL_SECONDS)
        except asyncio.TimeoutError:
            raise ValueError("voice_authority_timeout") from None
        payload = json.loads(body.decode("utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("authorized"), bool):
            raise ValueError("voice_authority_invalid")
        return payload["authorized"]


def create_streaming_app(*, host_origin, host_token, control_token, actor_ref, target, port,
                         speech_url="http://127.0.0.1:7730", gateway_listen=None, gateway_origin=None,
                         state_path=None):
    if (not isinstance(control_token, str) or not 32 <= len(control_token) <= 128
            or not control_token.isascii() or not control_token.replace("-", "").replace("_", "").isalnum()
            or not 1024 <= port <= 65535):
        raise ValueError("media_control_configuration_invalid")
    speech_url = RemoteSpeech.loopback(speech_url)
    if gateway_listen is None or gateway_origin is None or not state_path:
        # Effect-time device authority and persisted start evidence are
        # mandatory wiring, never optional.
        raise ValueError("gateway_authority_configuration_required")
    state = {}

    @asynccontextmanager
    async def lifespan(app):
        # Remote-only speech: the Dyno-owned MLX process owns the weights.
        # Health is validated by shape (`ok` + boolean model flags); the flags
        # are lazy-load state, so false never blocks startup. No local weights
        # are ever loaded and there is no local fallback path.
        speech = RemoteSpeech(speech_url)
        bridge = HostVoiceBridge(host_origin, host_token, actor_ref, target)
        authority = GatewayAuthority(gateway_listen, gateway_origin, control_token)
        evidence = MediaEvidence(state_path)
        state.update(speech=speech, bridge=bridge, authority=authority, evidence=evidence)
        started = False
        drained = False
        try:
            # Registration/current writer scope must work before listening for
            # media. No inference or historical turn replay occurs here.
            await bridge.validate_scope(target)
            if not await asyncio.to_thread(speech.refresh_health):
                raise ValueError("speech_backend_models_not_ready")
            started = True
            yield
            drained = True
        finally:
            # A nested media lifespan must finish draining before this context
            # exits normally. Unknown teardown preserves resources for process
            # recovery rather than claiming cleanup or closing an in-flight RPC.
            if not started or drained:
                await bridge.close()
                speech.close()
                await authority.close()
                evidence.close()
                state.clear()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    origin = f"http://127.0.0.1:{port}"

    class MediaBoundary:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return await self.app(scope, receive, send)
            request = Request(scope, receive)
            header = request.headers.get("authorization", "")
            csrf = request.headers.get("x-ghost-csrf", "")
            valid_header = header.isascii() and hmac.compare_digest(header, "Bearer " + control_token)
            valid_csrf = csrf.isascii() and hmac.compare_digest(csrf, control_token)
            code, status = None, 403
            if (request.headers.get("host") != f"127.0.0.1:{port}"
                    or request.headers.get("origin") not in {None, origin}
                    or request.headers.get("sec-fetch-site") not in {None, "same-origin"}):
                code = "media_loopback_boundary"
            elif not valid_header or not valid_csrf:
                code = "media_unauthorized"
            elif request.method in {"POST", "PATCH"}:
                length = request.headers.get("content-length", "")
                if not length.isdecimal() or int(length) > 65536:
                    code, status = "media_body_size_invalid", 413

            async def safe_headers(message):
                if message["type"] == "http.response.start":
                    message["headers"] = list(message.get("headers", [])) + [
                        (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")]
                await send(message)

            if code:
                return await JSONResponse({"error": {"code": code}}, status_code=status)(scope, receive, safe_headers)
            await self.app(scope, receive, safe_headers)

    app.add_middleware(MediaBoundary)

    @app.exception_handler(VoiceHostError)
    async def host_error(request, error):
        return JSONResponse({"error": {"code": "media_host_unavailable"}}, status_code=503)

    @app.exception_handler(SpeechError)
    async def speech_error(request, error):
        return JSONResponse({"error": {"code": "media_speech_unavailable"}}, status_code=503)

    async def resolve_context(request):
        bridge = state["bridge"]
        # Fresh R1 inspection fences a revoked/old writer and validates this
        # immutable pair before every new connection/control operation.
        await bridge.validate_scope(target)
        # The gateway is the only control-token holder and stamps every media
        # request with the authenticated device installation. Sessions and
        # controls are fenced to this identity for their whole lifetime, and
        # every Host effect re-checks it against the revocation source.
        installation = request.headers.get("x-ghost-media-device", "")
        if INSTALLATION_PATTERN.fullmatch(installation) is None:
            raise ValueError("media_installation_identity_invalid")
        return MediaContext(target=target, host=bridge, speech=state["speech"], language="ko", voice="Sohee",
                            installation=installation, authority=state["authority"])

    app.include_router(create_streaming_router(resolve_context, resolve_evidence=lambda: state["evidence"]))

    @app.get("/health")
    async def health():
        await asyncio.to_thread(state["speech"].refresh_health)
        return {"service": "ghost-streaming-media", "version": 1, "pid": os.getpid(),
                "transport": "small-webrtc", "stt": "remote-final-segment-batch", "tts": "remote-pcm-chunks",
                "speech_backend": {"remote": True, "models": state["speech"].ready},
                "model_loaded": state["speech"].ready}

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host-origin", required=True)
    parser.add_argument("--ghost-id", required=True)
    parser.add_argument("--conversation-id", required=True)
    parser.add_argument("--authority-epoch", type=int, required=True)
    parser.add_argument("--actor-ref", required=True)
    parser.add_argument("--speech-url", default="http://127.0.0.1:7730")
    parser.add_argument("--state-path", required=True,
                        help="owner-writable path for persisted start/tombstone evidence")
    parser.add_argument("--gateway-listen", required=True,
                        help="loopback http URL of the gateway listener, e.g. http://127.0.0.1:8788")
    parser.add_argument("--gateway-origin", required=True,
                        help="public gateway origin used for its Host/origin boundary, e.g. https://ghost.example")
    args = parser.parse_args()
    host_token = os.environ.get("GHOST_VOICE_HOST_TOKEN", "")
    control_token = os.environ.get("GHOST_VOICE_CONTROL_TOKEN", "")
    if not host_token or not control_token:
        parser.error("required task-scoped voice tokens are missing")
    target = ConversationTarget(ghost_id=args.ghost_id, conversation_id=args.conversation_id,
                                privacy="local_only", authority_epoch=args.authority_epoch)
    app = create_streaming_app(host_origin=args.host_origin, host_token=host_token, control_token=control_token,
                               actor_ref=args.actor_ref, target=target, port=args.port,
                               speech_url=args.speech_url, gateway_listen=args.gateway_listen,
                               gateway_origin=args.gateway_origin, state_path=args.state_path)
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning",
                timeout_graceful_shutdown=180)
