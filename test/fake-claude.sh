#!/usr/bin/env bash
# Stands in for the real CLI so the queue can be tested without spending tokens.
# Echoes the arguments it was given so the test can assert on them.
cat > /dev/null   # drain the prompt on stdin
echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake-session\",\"args\":\"$*\"}"
if [ "$TOKIO_FAKE_MODE" = "ratelimit" ]; then
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"fake-session","result":"Claude usage limit reached. Your limit will reset at 11pm."}'
  exit 1
fi
if [ "$TOKIO_FAKE_MODE" = "crash" ]; then
  echo 'boom' >&2
  exit 3
fi
echo '{"type":"assistant","session_id":"fake-session","message":{"content":[{"type":"text","text":"done: tests pass"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"fake-session","total_cost_usd":2.5,"result":"done: tests pass"}'
