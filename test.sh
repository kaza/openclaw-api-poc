#!/usr/bin/env bash
#
# OpenClaw API POC — Integration Test Suite
#
# Tests session routing via the OpenResponses API.
# Usage: ./test.sh [gateway-url] [token]
#
# Defaults: gateway=http://localhost:18789, token=$OPENCLAW_GATEWAY_TOKEN
#
set -euo pipefail

GATEWAY="${1:-http://localhost:18789}"
TOKEN="${2:-${OPENCLAW_GATEWAY_TOKEN:-}}"
AGENT="main"
PASS=0
FAIL=0
TOTAL=0

if [[ -z "$TOKEN" ]]; then
  echo "❌ No token provided. Usage: ./test.sh [gateway-url] [token]"
  echo "   Or set OPENCLAW_GATEWAY_TOKEN env var."
  exit 1
fi

# --- Helpers ---

api() {
  local user="$1" input="$2"
  curl -sS "${GATEWAY}/v1/responses" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"openclaw:${AGENT}\",
      \"input\": \"${input}\",
      \"user\": \"${user}\"
    }" 2>&1
}

extract_text() {
  # Extract assistant text from response JSON
  echo "$1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'output' in data:
    for item in data['output']:
        if item.get('type') == 'message' and item.get('role') == 'assistant':
            for part in item.get('content', []):
                if part.get('type') == 'output_text':
                    print(part['text'])
                    sys.exit(0)
if 'error' in data:
    print('ERROR: ' + data['error'].get('message', str(data['error'])))
    sys.exit(1)
print('(no text)')
" 2>&1
}

assert_contains() {
  local test_name="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -qi "$needle"; then
    echo "  ✅ ${test_name}"
    PASS=$((PASS + 1))
  else
    echo "  ❌ ${test_name}"
    echo "     Expected to contain: '${needle}'"
    echo "     Got: '${haystack}'"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local test_name="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -qi "$needle"; then
    echo "  ❌ ${test_name}"
    echo "     Expected NOT to contain: '${needle}'"
    echo "     Got: '${haystack}'"
    FAIL=$((FAIL + 1))
  else
    echo "  ✅ ${test_name}"
    PASS=$((PASS + 1))
  fi
}

# Use unique user IDs per test run to avoid session bleed from previous runs
RUN_ID="test-$(date +%s)"
USER_A="Alice-${RUN_ID}"
USER_B="Bob-${RUN_ID}"

echo ""
echo "🔌 OpenClaw API POC — Integration Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Gateway: ${GATEWAY}"
echo "  Agent:   ${AGENT}"
echo "  Run ID:  ${RUN_ID}"
echo ""

# --- Test 1: Basic API call ---
echo "📋 Test 1: Basic API connectivity"
RAW=$(api "${USER_A}" "Say exactly: PONG")
TEXT=$(extract_text "$RAW")
assert_contains "API returns a response" "$TEXT" "PONG"

# --- Test 2: Session memory (user A) ---
echo ""
echo "📋 Test 2: Session memory — User A introduces themselves"
RAW=$(api "${USER_A}" "My name is Alice. Remember that. Reply with just: OK ALICE")
TEXT=$(extract_text "$RAW")
assert_contains "User A introduction acknowledged" "$TEXT" "ALICE"

# --- Test 3: Session isolation (user B) ---
echo ""
echo "📋 Test 3: Session isolation — User B is separate"
RAW=$(api "${USER_B}" "My name is Bob. Remember that. Reply with just: OK BOB")
TEXT=$(extract_text "$RAW")
assert_contains "User B introduction acknowledged" "$TEXT" "BOB"

# --- Test 4: User B doesn't know about User A ---
echo ""
echo "📋 Test 4: Session isolation — User B doesn't know Alice"
RAW=$(api "${USER_B}" "Do you know anyone named Alice in our conversation? Answer YES or NO only.")
TEXT=$(extract_text "$RAW")
assert_contains "User B doesn't know Alice" "$TEXT" "NO"

# --- Test 5: User A remembers their name ---
echo ""
echo "📋 Test 5: Session continuity — User A still remembers"
RAW=$(api "${USER_A}" "What is my name? Reply with just the name, nothing else.")
TEXT=$(extract_text "$RAW")
assert_contains "User A name recalled" "$TEXT" "Alice"

# --- Test 6: User B remembers their name ---
echo ""
echo "📋 Test 6: Session continuity — User B still remembers"
RAW=$(api "${USER_B}" "What is my name? Reply with just the name, nothing else.")
TEXT=$(extract_text "$RAW")
assert_contains "User B name recalled" "$TEXT" "Bob"

# --- Test 7: Streaming endpoint works ---
echo ""
echo "📋 Test 7: Streaming response"
STREAM_RAW=$(curl -sS "${GATEWAY}/v1/responses" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"openclaw:${AGENT}\",
    \"input\": \"Say exactly: STREAM_OK\",
    \"user\": \"${USER_A}\",
    \"stream\": true
  }" 2>&1)
TOTAL=$((TOTAL + 1))
if echo "$STREAM_RAW" | grep -q "response.output_text.delta"; then
  echo "  ✅ SSE streaming returns delta events"
  PASS=$((PASS + 1))
else
  echo "  ❌ SSE streaming returns delta events"
  echo "     Got: $(echo "$STREAM_RAW" | head -5)"
  FAIL=$((FAIL + 1))
fi

# --- Test 8: Auth rejection ---
echo ""
echo "📋 Test 8: Auth — bad token rejected"
BAD_RAW=$(curl -sS -o /dev/null -w "%{http_code}" "${GATEWAY}/v1/responses" \
  -H "Authorization: Bearer bad-token-12345" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw:main","input":"hi"}' 2>&1)
TOTAL=$((TOTAL + 1))
if [[ "$BAD_RAW" == "401" ]]; then
  echo "  ✅ Bad token returns 401"
  PASS=$((PASS + 1))
else
  echo "  ❌ Bad token returns 401 (got: ${BAD_RAW})"
  FAIL=$((FAIL + 1))
fi

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $FAIL -eq 0 ]]; then
  echo "🎉 All ${TOTAL} tests passed!"
else
  echo "📊 Results: ${PASS}/${TOTAL} passed, ${FAIL} failed"
fi
echo ""

exit $FAIL
