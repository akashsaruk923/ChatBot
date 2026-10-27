#!/usr/bin/env python3
"""Exercise an already-running local API in explicit demo mode."""

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = "http://127.0.0.1:5088"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
session = str(uuid.uuid4())


def request(path, body=None, owner=session):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={
        "Content-Type": "application/json", "X-Dadus-Session": owner,
    })
    with opener.open(req, timeout=15) as response:
        assert response.status == 200
        return json.load(response)


health = request("/api/health")
assert health == {"status": "ok", "mode": "demo", "database": "ready"}, health
catalog = request("/api/agents")["agents"]
assert {agent["id"] for agent in catalog} == {"companion", "planner", "coding"}
sent = request("/api/chat/message", {"message": "नमस्कार! This is a local smoke test."})
assert sent["mode"] == "demo" and sent["message"]["role"] == "assistant"
assert sent["agentId"] == "companion"
conversation = sent["conversationId"]
history_path = "/api/chat/history?" + urllib.parse.urlencode({"conversationId": conversation})
history = request(history_path)
assert len(history["messages"]) == 2
assert [message["role"] for message in history["messages"]] == ["user", "assistant"]
assert history["messages"][1]["content"] == sent["message"]["content"]
assert any(row["id"] == conversation for row in request("/api/chat/conversations")["conversations"])
try:
    request(history_path, owner=str(uuid.uuid4()))
    raise AssertionError("A different anonymous session could read the conversation")
except urllib.error.HTTPError as error:
    assert error.code == 404, error.code
calculation = request("/api/chat/message", {
    "conversationId": conversation, "message": "/calculate (12+3)*2", "agentId": "planner",
})
assert calculation["mode"] == "demo" and calculation["agentId"] == "planner"
assert "30" in calculation["message"]["content"]
assert len(calculation["tools"]) == 1 and calculation["tools"][0]["name"] == "calculate"
clock = request("/api/chat/message", {
    "conversationId": conversation, "message": "/time Asia/Kolkata", "agentId": "coding",
})
assert clock["agentId"] == "coding" and clock["tools"][0]["name"] == "get_current_time"
assert clock["tools"][0]["summary"]
assert len(request(history_path)["messages"]) == 6
print("Demo API smoke passed: storage, session isolation, three agents, real calculator/time tools and persisted exchanges.")
