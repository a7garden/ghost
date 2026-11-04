"""Loopback R1 adapter: media never owns model history or completion facts."""

import hashlib
import json
import uuid
from urllib.parse import urlsplit

import httpx

from streaming import ConversationTarget, VoiceTurn


class VoiceHostError(Exception):
    """Safe code only; never expose Host bodies, tokens or transcripts."""


class HostVoiceBridge:
    def __init__(self, origin: str, token: str, actor_ref: str, target: ConversationTarget):
        parsed = urlsplit(origin)
        try:
            port = parsed.port
        except ValueError:
            raise VoiceHostError("host_origin_invalid") from None
        if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
                or not port or parsed.username is not None or parsed.password is not None
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
            raise VoiceHostError("host_origin_invalid")
        if not token or not actor_ref or type(target.authority_epoch) is not int or not 0 < target.authority_epoch <= 2**53 - 1:
            raise VoiceHostError("host_identity_invalid")
        if target.privacy not in {"public", "private", "local_only"}:
            raise VoiceHostError("host_scope_invalid")
        for identifier in (target.ghost_id, target.conversation_id):
            if not isinstance(identifier, str) or not identifier or len(identifier.encode("utf-8")) > 512:
                raise VoiceHostError("host_scope_invalid")
        self._origin = origin.rstrip("/")
        self._actor_ref = actor_ref
        self._target = target
        self._client = httpx.AsyncClient(
            timeout=10, follow_redirects=False, trust_env=False,
            headers={"Authorization": "Bearer " + token, "X-Ghost-CSRF": token,
                     "Origin": self._origin, "Sec-Fetch-Site": "same-origin",
                     "Content-Type": "application/json"},
        )

    async def close(self):
        await self._client.aclose()

    def _scope(self, target):
        if target != self._target:
            raise VoiceHostError("host_scope_mismatch")
        return {"ghost_id": target.ghost_id, "conversation_id": target.conversation_id}

    async def validate_scope(self, target: ConversationTarget):
        page = await self._request({"method": "conversation.inspect", **self._scope(target), "limit": 1})
        if (page.get("ghost_id") != target.ghost_id or page.get("conversation_id") != target.conversation_id
                or page.get("privacy") != target.privacy):
            raise VoiceHostError("host_scope_mismatch")

    async def _request(self, body, command_id=None):
        if command_id is None:
            command_id = str(uuid.uuid4())
        if not isinstance(command_id, str) or not command_id or len(command_id.encode("utf-8")) > 512:
            raise VoiceHostError("host_command_id_invalid")
        # The shared R1 canonical JSON is sorted-key UTF-8, integer-only. These
        # closed media methods contain strings and bounded integers only.
        try:
            canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, UnicodeError):
            raise VoiceHostError("host_payload_invalid") from None
        envelope = {
            "protocol_version": "ghost-lifetime/1", "command_id": command_id,
            "payload_digest": hashlib.sha256(canonical).hexdigest(),
            "actor_ref": self._actor_ref, "authority_epoch": self._target.authority_epoch,
            "expected_revision": None, "correlation_id": command_id, "body": body,
        }
        payload = {"request_id": str(uuid.uuid4()), "command": {"type": "lifetime", "envelope": envelope}}
        try:
            async with self._client.stream("POST", self._origin + "/api/v1/action", json=payload) as response:
                if response.status_code != 200:
                    raise VoiceHostError("host_http_rejected")
                parts, size = [], 0
                async for part in response.aiter_bytes():
                    size += len(part)
                    if size > 8 * 1024 * 1024:
                        raise VoiceHostError("host_response_size_invalid")
                    parts.append(part)
                value = json.loads(b"".join(parts))
        except httpx.TimeoutException:
            # An unknown submit keeps its original command ID; never replay it.
            raise VoiceHostError("host_effect_unknown") from None
        except (httpx.HTTPError, ValueError, UnicodeError):
            raise VoiceHostError("host_transport_failed") from None
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise VoiceHostError("host_control_rejected")
        result = value.get("result")
        if not isinstance(result, dict) or result.get("status") != "success" or not isinstance(result.get("data"), dict):
            raise VoiceHostError("host_command_rejected")
        return result["data"]

    async def submit(self, target: ConversationTarget, text: str, command_id: str) -> VoiceTurn:
        scope = self._scope(target)
        try:
            valid_text = isinstance(text, str) and bool(text.strip()) and len(text.encode("utf-8")) <= 65536
        except UnicodeError:
            valid_text = False
        if not valid_text:
            raise VoiceHostError("host_text_invalid")
        data = await self._request({"method": "conversation.input", **scope, "text": text,
                                    "privacy": target.privacy, "attachments": []}, command_id)
        if data.get("turn_id") != command_id or data.get("privacy") != target.privacy:
            raise VoiceHostError("host_submit_identity_mismatch")
        # Do not treat the intake ACK as an answer. Inspect the same committed ID.
        return await self.inspect(target, command_id)

    async def inspect(self, target: ConversationTarget, turn_id: str) -> VoiceTurn:
        scope = self._scope(target)
        data = await self._request({"method": "conversation.turn.inspect", **scope, "turn_id": turn_id})
        run = data.get("run")
        if (not isinstance(run, dict) or run.get("turn_id") != turn_id
                or run.get("ghost_id") != target.ghost_id or run.get("conversation_id") != target.conversation_id
                or run.get("state") not in {"queued", "running", "answered", "failed", "cancelled", "effect_unknown"}
                or type(run.get("cancel_requested")) is not bool):
            raise VoiceHostError("host_run_identity_mismatch")
        advisory = None
        if run["state"] == "answered" and not run["cancel_requested"]:
            advisory = await self._advisory(target, turn_id)
        return VoiceTurn(turn_id=turn_id, ghost_id=target.ghost_id, conversation_id=target.conversation_id,
                         state=run["state"], advisory_text=advisory)

    async def _advisory(self, target, turn_id):
        scope = self._scope(target)
        before = None
        # Search only this authenticated pair. The matching Owner turn is the
        # lower bound: an advisory cannot precede its source. No arbitrary latest
        # page cutoff can turn an old answered turn into a guessed blank reply.
        while True:
            body = {"method": "conversation.inspect", **scope, "limit": 100}
            if before is not None:
                body["before_sequence"] = before
            page = await self._request(body)
            turns = page.get("turns")
            if (page.get("ghost_id") != target.ghost_id or page.get("conversation_id") != target.conversation_id
                    or page.get("privacy") != target.privacy or not isinstance(turns, list) or len(turns) > 100
                    or type(page.get("has_older")) is not bool):
                raise VoiceHostError("host_history_scope_mismatch")
            replies = [row for row in turns if isinstance(row, dict)
                       and row.get("kind") == "assistant_advisory" and row.get("source_turn_id") == turn_id]
            if len(replies) > 1:
                raise VoiceHostError("host_advisory_conflict")
            if replies:
                reply = replies[0]
                text = reply.get("text")
                if reply.get("privacy") != target.privacy or not isinstance(text, str) or len(text.encode("utf-8")) > 65536:
                    raise VoiceHostError("host_advisory_invalid")
                return text
            if any(isinstance(row, dict) and row.get("id") == turn_id
                   and row.get("kind") == "user" and row.get("sender_kind") == "owner" for row in turns):
                return None
            if not page["has_older"]:
                raise VoiceHostError("host_source_turn_missing")
            oldest = page.get("oldest_sequence")
            if type(oldest) is not int or oldest < 1 or (before is not None and oldest >= before):
                raise VoiceHostError("host_history_cursor_invalid")
            before = oldest

    async def cancel(self, target: ConversationTarget, turn_id: str, command_id: str) -> VoiceTurn:
        scope = self._scope(target)
        await self._request({"method": "conversation.cancel_turn", **scope, "turn_id": turn_id}, command_id)
        # Return actual current state; request acknowledgement is not cancellation
        # completion and does not cancel any independent accepted Goal/Work.
        return await self.inspect(target, turn_id)
