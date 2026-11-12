#!/bin/sh
# End-to-end smoke test against a running API: health, sign-up, a knowledge
# note through the job runner, and one streamed answer that cites the note.
#
#   infra/docker/smoke.sh http://127.0.0.1:4000
#
# Needs curl and jq, and a configured chat model (the labelled development
# provider is enough). EXPECT_STORAGE=ephemeral|durable also checks /health.
set -eu

BASE="${1:-http://127.0.0.1:4000}"
WAIT="${SMOKE_WAIT_SECONDS:-120}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "SMOKE FAILED: $*" >&2
  exit 1
}

echo "waiting for $BASE/health (up to ${WAIT}s)"
i=0
until curl -fsS "$BASE/health" >"$TMP/health.json" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt "$WAIT" ] || fail "the API did not become healthy"
  sleep 1
done
cat "$TMP/health.json"
echo
[ "$(jq -r .status "$TMP/health.json")" = "ok" ] || fail "health status is not ok"
if [ -n "${EXPECT_STORAGE:-}" ]; then
  [ "$(jq -r .storage "$TMP/health.json")" = "$EXPECT_STORAGE" ] ||
    fail "expected storage $EXPECT_STORAGE"
fi

EMAIL="smoke-$(date +%s)-$$@example.com"
curl -fsS -X POST "$BASE/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"a long and sturdy passphrase\",\"displayName\":\"Smoke Test\"}" \
  >"$TMP/register.json" || fail "sign-up was refused"
TOKEN="$(jq -r .accessToken "$TMP/register.json")"
WS="$(jq -r .workspace.id "$TMP/register.json")"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "sign-up returned no access token"
AUTH="authorization: Bearer $TOKEN"
echo "registered $EMAIL in workspace $WS"

curl -fsS -X POST "$BASE/v1/workspaces/$WS/knowledge/notes" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d '{"title":"Contractor policy memo","content":"# Contractor policy\n\nThe revised contractor policy took effect in March 2024 and applies to all independent contractors.\n\n## Penalties\n\nPenalties for late training completion are assessed quarterly by the finance team."}' \
  >"$TMP/note.json" || fail "could not create a note"
KID="$(jq -r .knowledge.id "$TMP/note.json")"
i=0
while :; do
  STATUS="$(curl -fsS "$BASE/v1/workspaces/$WS/knowledge/$KID" -H "$AUTH" | jq -r .knowledge.status)"
  [ "$STATUS" = "READY" ] && break
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "the note was not indexed (status $STATUS); is the job runner running?"
  sleep 1
done
echo "note indexed by the job runner"

CID="$(curl -fsS -X POST "$BASE/v1/workspaces/$WS/conversations" -H "$AUTH" \
  -H 'content-type: application/json' -d '{}' | jq -r '.id // .conversation.id')"
[ -n "$CID" ] && [ "$CID" != "null" ] || fail "could not create a conversation"
curl -fsS -N -X POST "$BASE/v1/workspaces/$WS/conversations/$CID/messages" -H "$AUTH" \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"content":"When did the contractor policy take effect, and who assesses penalties?"}' \
  >"$TMP/ask.sse" || fail "the question was refused"
grep -A1 '^event: complete' "$TMP/ask.sse" | tail -n 1 | sed 's/^data: //' >"$TMP/complete.json"
DISPOSITION="$(jq -r .answerRecord.disposition "$TMP/complete.json")"
CITATIONS="$(jq -r '.answerRecord.citations | length' "$TMP/complete.json")"
MODEL="$(grep -A1 '^event: model_selected' "$TMP/ask.sse" | tail -n 1 | sed 's/^data: //' | jq -r .displayName)"
echo "answer: $DISPOSITION from \"$MODEL\" with $CITATIONS citation(s)"
[ "$DISPOSITION" = "ANSWERED" ] || fail "expected ANSWERED, got $DISPOSITION"
[ "$CITATIONS" -ge 1 ] || fail "expected at least one citation"

echo "SMOKE OK"
