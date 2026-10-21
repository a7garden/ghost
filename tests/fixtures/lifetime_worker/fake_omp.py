#!/usr/bin/env python3
"""Finite OMP RPC fixture; no network, model, credentials, or shell tools."""
import json
import os
import signal
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
orphan_marker = sys.argv[2] if mode == "orphan_on_eof" and len(sys.argv) > 2 else None
session_dir = None
provider = "fixture"
model_id = "test-model"
thinking_level = "off"
host_tools = []


def record_orphan_termination(_signum, _frame):
    if orphan_marker is not None:
        with open(orphan_marker, "w", encoding="utf-8") as marker:
            marker.write("terminated")
    raise SystemExit(0)


signal.signal(signal.SIGTERM, record_orphan_termination)


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_command():
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


def host_tool(tool_call_id, tool_name, arguments, request_id):
    emit({
        "type": "host_tool_call",
        "id": request_id,
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "arguments": arguments,
    })
    response = read_command()
    if response is None or response.get("type") != "host_tool_result" or response.get("id") != request_id:
        raise RuntimeError("host tool response id did not match")
    return response


def tool_value(response):
    return json.loads(response["result"]["content"][0]["text"])


emit({"type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2], "maxFrameBytes": 1048576, "maxReassembledFrameBytes": 67108864})
while True:
    request = read_command()
    if request is None:
        if mode == "orphan_on_eof":
            time.sleep(30)
            continue
        break
    request_id = request.get("id")
    kind = request.get("type")
    if kind == "negotiate_protocol":
        emit({"type": "response", "id": request_id, "command": kind, "success": True, "data": {"protocolVersion": 2}})
    elif kind == "open_session":
        session_dir = request["sessionDir"]
        provider = request["provider"]
        model_id = request["modelId"]
        emit({"type": "response", "id": request_id, "command": kind, "success": True, "data": {"cancelled": False, "resumed": False, "sessionId": "fixture-session", "sessionFile": os.path.join(session_dir, "fixture.jsonl")}})
    elif kind == "set_thinking_level":
        thinking_level = request["level"]
        emit({"type": "response", "id": request_id, "command": kind, "success": True})
    elif kind == "set_auto_retry":
        emit({"type": "response", "id": request_id, "command": kind, "success": True})
    elif kind == "set_host_tools":
        host_tools = [tool["name"] for tool in request["tools"]]
        emit({"type": "response", "id": request_id, "command": kind, "success": True, "data": {"toolNames": host_tools}})
    elif kind == "get_state":
        emit({"type": "response", "id": request_id, "command": kind, "success": True, "data": {
            "model": {"provider": provider, "id": model_id},
            "thinkingLevel": thinking_level,
            "dumpTools": [{"name": name, "description": "fixture tool", "parameters": {}} for name in host_tools],
        }})
    elif kind == "prompt":
        emit({"type": "response", "id": request_id, "command": kind, "success": True, "data": {"agentInvoked": True}})
        if mode in ("orphan_on_eof", "wait_control", "late_tool_after_cancel"):
            continue
        if mode in ("tool_flow", "tool_conflict_flow", "tool_escape_flow"):
            if mode == "tool_escape_flow":
                paths = ["../sentinel.txt", "/etc/passwd", "file:///etc/passwd", "outside-link", "hard-link"]
                for index, path in enumerate(paths):
                    for name in ("canary_read", "canary_write"):
                        arguments = {"path": path}
                        if name == "canary_write":
                            arguments["content"] = "Unauthorized replacement"
                        denied = host_tool(f"denied-{index}-{name}", name, arguments, f"denied-request-{index}-{name}")
                        if not denied.get("isError"):
                            raise RuntimeError("scoped tool admitted an escaping path")
            first = host_tool("fixture-tool-write", "canary_write", {"path": "answer.txt", "content": "C2 scoped artifact"}, "fixture-host-write-1")
            if first.get("isError"):
                raise RuntimeError("fixture write was rejected")
            if mode == "tool_conflict_flow":
                replay = host_tool("fixture-tool-write", "canary_write", {"path": "answer.txt", "content": "C2 scoped artifact"}, "fixture-host-write-replay")
                if replay.get("isError"):
                    raise RuntimeError("exact replay was rejected")
                if replay["result"].get("details") != first["result"].get("details"):
                    raise RuntimeError("exact replay changed the durable receipt")
                conflict = host_tool("fixture-tool-write", "canary_write", {"path": "answer.txt", "content": "changed payload"}, "fixture-host-write-conflict")
                if not conflict.get("isError") or tool_value(conflict).get("error_code") != "tool_call_conflict":
                    raise RuntimeError("changed tool payload did not conflict")
            read = host_tool("fixture-tool-read", "canary_read", {"path": "answer.txt"}, "fixture-host-read")
            read_value = tool_value(read)
            if read.get("isError") or read_value.get("content") != "C2 scoped artifact":
                raise RuntimeError("fixture read did not return the durable file contents")
            emit({"type": "prompt_result", "id": request_id, "agentInvoked": True, "status": "completed", "sessionSettled": True})
            emit({"type": "session_settled"})
            continue
        if mode == "eof_before_settled":
            sys.exit(9)
        if mode == "large_progress":
            emit({"type": "message_update", "text": "x" * 4096})
        if mode == "yield_then_settle":
            emit({"type": "prompt_result", "id": request_id, "agentInvoked": True, "status": "completed", "sessionSettled": False})
            time.sleep(0.1)
            emit({"type": "session_settled"})
        else:
            emit({"type": "prompt_result", "id": request_id, "agentInvoked": True, "status": "completed", "sessionSettled": True})
            emit({"type": "session_settled"})
    elif kind == "steer":
        emit({"type": "response", "id": request_id, "command": kind, "success": True})
    elif kind == "abort":
        emit({"type": "response", "id": request_id, "command": kind, "success": True})
        if mode == "late_tool_after_cancel":
            late = host_tool("late-cancel-write", "canary_write", {"path": "after-cancel.txt", "content": "Late forbidden effect"}, "late-cancel-rpc")
            emit({"type": "message_update", "late_tool_error": tool_value(late).get("error_code")})
        emit({"type": "session_settled"})
    else:
        emit({"type": "response", "id": request_id, "command": kind or "unknown", "success": False, "error": "unsupported fixture command"})
