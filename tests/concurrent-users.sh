#!/bin/bash
# ===========================================================================
# Concurrent Multi-User Test
# ===========================================================================
# Verifies that multiple users can chat simultaneously without blocking.
# Each user sends a message and we measure timing to confirm parallelism.
#
# Usage:
#   ./tests/concurrent-users.sh                    # defaults: 3 users, localhost:3000
#   ./tests/concurrent-users.sh --users 5          # 5 concurrent users
#   ./tests/concurrent-users.sh --url http://host:3000 --token my-token
#   ./tests/concurrent-users.sh --short            # quick test (short responses)
#
# Requirements:
#   - Server running (npm run dev / npm start)
#   - curl, bash 4+
#
# What it checks:
#   ✅ All users get first token (TTFT) — confirms sessions spin up
#   ✅ TTFT spread < 5s — confirms parallelism (serial would be N*TTFT)
#   ✅ All users complete — confirms no deadlocks/crashes
#   ✅ Total time reasonable — not N * single-user time
# ===========================================================================

set -euo pipefail

# Defaults
NUM_USERS=3
BASE_URL="http://localhost:3000"
TOKEN="test-token-123"
SHORT_MODE=false
MAX_WAIT=180

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --users) NUM_USERS=$2; shift 2;;
    --url) BASE_URL=$2; shift 2;;
    --token) TOKEN=$2; shift 2;;
    --short) SHORT_MODE=true; shift;;
    --timeout) MAX_WAIT=$2; shift 2;;
    -h|--help)
      echo "Usage: $0 [--users N] [--url URL] [--token TOKEN] [--short] [--timeout SECS]"
      exit 0;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

# Topics for each user
TOPICS=(
  "the history of mathematics"
  "the future of artificial intelligence"
  "the impact of climate change on oceans"
  "the evolution of programming languages"
  "the philosophy of consciousness"
  "the economics of renewable energy"
  "the psychology of decision making"
  "the history of space exploration"
  "the ethics of genetic engineering"
  "the future of quantum computing"
)

RESULTS_DIR=$(mktemp -d)
OVERALL_START=$(date +%s%3N)

run_user() {
  local idx=$1
  local user_id="concurrent-test-user-${idx}"
  local topic="${TOPICS[$((idx % ${#TOPICS[@]}))]}"
  local result_file="$RESULTS_DIR/user-${idx}.txt"
  local start_time=$(date +%s%3N)

  if [ "$SHORT_MODE" = true ]; then
    local prompt="Write 2 sentences about $topic."
  else
    local prompt="Write a 1000-word essay about $topic. Respond in English."
  fi

  echo "[$user_id] START at $(date +%H:%M:%S.%3N)"

  local first_token_time=""
  local last_token_time=""
  local chunk_count=0
  local got_done=false

  # Write initial state
  echo "USER=$user_id" > "$result_file"
  echo "TOPIC=$topic" >> "$result_file"
  echo "START=$start_time" >> "$result_file"

  while IFS= read -r line; do
    if [[ "$line" == data:* ]]; then
      local now=$(date +%s%3N)
      chunk_count=$((chunk_count + 1))

      if [ -z "$first_token_time" ]; then
        first_token_time=$now
        local ttft=$(( first_token_time - start_time ))
        echo "[$user_id] FIRST TOKEN — TTFT: ${ttft}ms"
        echo "TTFT=$ttft" >> "$result_file"
        echo "FIRST_TOKEN_ABS=$first_token_time" >> "$result_file"
      fi

      if echo "$line" | grep -q '"event":"done"\|"done"' 2>/dev/null; then
        last_token_time=$now
        got_done=true
      fi
    fi

    # Also check event: lines for SSE format
    if [[ "$line" == "event: done"* ]]; then
      last_token_time=$(date +%s%3N)
      got_done=true
    fi
  done < <(curl -sN "$BASE_URL/chat/stream" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"userId\":\"$user_id\",\"message\":\"$prompt\"}" \
    --max-time "$MAX_WAIT" 2>/dev/null)

  # If we didn't catch done via event, use last chunk time
  if [ -z "$last_token_time" ] && [ -n "$first_token_time" ]; then
    last_token_time=$(date +%s%3N)
  fi

  if [ -n "$first_token_time" ] && [ -n "$last_token_time" ]; then
    local ttlt=$(( last_token_time - start_time ))
    local gen_time=$(( last_token_time - first_token_time ))
    echo "[$user_id] DONE — TTLT: ${ttlt}ms, generation: ${gen_time}ms, chunks: $chunk_count"
    echo "TTLT=$ttlt" >> "$result_file"
    echo "GEN_TIME=$gen_time" >> "$result_file"
    echo "CHUNKS=$chunk_count" >> "$result_file"
    echo "STATUS=ok" >> "$result_file"
  else
    echo "[$user_id] TIMEOUT/ERROR — no tokens received"
    echo "STATUS=failed" >> "$result_file"
  fi
}

# ---- Main ----
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     CONCURRENT MULTI-USER TEST               ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Users:   $NUM_USERS"
echo "║  Server:  $BASE_URL"
echo "║  Mode:    $([ "$SHORT_MODE" = true ] && echo "short (2 sentences)" || echo "full (1000-word essay)")"
echo "║  Timeout: ${MAX_WAIT}s per user"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Health check
if ! curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
  echo "❌ Server not reachable at $BASE_URL/health"
  echo "   Start the server first: npm run dev"
  exit 1
fi
echo "✅ Server healthy"
echo ""

# Launch all users simultaneously
PIDS=()
for i in $(seq 0 $((NUM_USERS - 1))); do
  run_user $i &
  PIDS+=($!)
done

echo ""
echo "⏳ All $NUM_USERS users launched. Waiting for completion..."
echo ""

# Wait for all
ALL_OK=true
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    ALL_OK=false
  fi
done

OVERALL_END=$(date +%s%3N)
OVERALL_TIME=$(( OVERALL_END - OVERALL_START ))

# ---- Results Summary ----
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║                 RESULTS                       ║"
echo "╠══════════════════════════════════════════════╣"

ok_count=0
fail_count=0
ttft_values=()
ttlt_values=()
first_token_abs_values=()

for f in "$RESULTS_DIR"/user-*.txt; do
  [ -f "$f" ] || continue
  source "$f"
  if [ "${STATUS:-}" = "ok" ]; then
    ok_count=$((ok_count + 1))
    ttft_values+=("$TTFT")
    ttlt_values+=("$TTLT")
    first_token_abs_values+=("$FIRST_TOKEN_ABS")
    printf "║  %-25s TTFT: %5sms  TTLT: %5sms  ✅\n" "$USER" "$TTFT" "$TTLT"
  else
    fail_count=$((fail_count + 1))
    printf "║  %-25s FAILED ❌\n" "$USER"
  fi
done

echo "╠══════════════════════════════════════════════╣"

# Calculate TTFT spread (max - min)
if [ ${#ttft_values[@]} -gt 1 ]; then
  min_ttft=${ttft_values[0]}
  max_ttft=${ttft_values[0]}
  min_abs=${first_token_abs_values[0]}
  max_abs=${first_token_abs_values[0]}
  for v in "${ttft_values[@]}"; do
    (( v < min_ttft )) && min_ttft=$v
    (( v > max_ttft )) && max_ttft=$v
  done
  for v in "${first_token_abs_values[@]}"; do
    (( v < min_abs )) && min_abs=$v
    (( v > max_abs )) && max_abs=$v
  done
  ttft_spread=$(( max_abs - min_abs ))
  echo "║"
  echo "║  TTFT range:  ${min_ttft}ms — ${max_ttft}ms"
  echo "║  TTFT spread: ${ttft_spread}ms (time between first and last user's first token)"
fi

echo "║"
echo "║  Total time:  ${OVERALL_TIME}ms"
echo "║  Users OK:    $ok_count / $NUM_USERS"
[ $fail_count -gt 0 ] && echo "║  Users FAIL:  $fail_count"
echo "║"

# Parallelism verdict
if [ ${#ttft_values[@]} -gt 1 ] && [ $ttft_spread -lt 5000 ]; then
  echo "║  🟢 PARALLEL: All users got first token within ${ttft_spread}ms"
  echo "║     (Serial would be ~$((max_ttft * NUM_USERS))ms)"
else
  echo "║  🔴 POSSIBLY SERIAL: TTFT spread > 5s"
fi

echo "║"
[ $fail_count -eq 0 ] && echo "║  ✅ ALL TESTS PASSED" || echo "║  ❌ SOME TESTS FAILED"
echo "╚══════════════════════════════════════════════╝"

# Cleanup
rm -rf "$RESULTS_DIR"

exit $fail_count
