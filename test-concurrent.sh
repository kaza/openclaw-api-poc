#!/bin/bash
# Concurrent multi-user test
# Spawns 3 users simultaneously, each requesting a 1000-word essay
# Measures: time-to-first-token (TTFT), time-to-last-token (TTLT)

TOKEN="test-token-123"
BASE="http://localhost:3000"

run_user() {
  local user_id=$1
  local topic=$2
  local start_time=$(date +%s%3N)
  local first_token_time=""
  local last_token_time=""
  local token_count=0
  local tmpfile=$(mktemp)

  echo "[$user_id] START at $(date +%H:%M:%S.%3N) — topic: $topic"

  # Stream request
  curl -sN "$BASE/chat/stream" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"userId\":\"$user_id\",\"message\":\"Write a 1000-word essay about $topic. Respond in English.\"}" \
    --max-time 120 2>/dev/null | while IFS= read -r line; do
      if [[ "$line" == data:* ]]; then
        now=$(date +%s%3N)
        token_count=$((token_count + 1))

        if [ -z "$first_token_time" ]; then
          first_token_time=$now
          ttft=$(( first_token_time - start_time ))
          echo "[$user_id] FIRST TOKEN at $(date +%H:%M:%S.%3N) — TTFT: ${ttft}ms"
          echo "TTFT=$ttft" > "$tmpfile"
        fi

        # Check if this is the done event
        if echo "$line" | grep -q '"done"'; then
          last_token_time=$now
          ttlt=$(( last_token_time - start_time ))
          ttft_val=$(grep TTFT "$tmpfile" 2>/dev/null | cut -d= -f2)
          gen_time=$(( last_token_time - start_time - ${ttft_val:-0} ))
          echo "[$user_id] DONE at $(date +%H:%M:%S.%3N) — TTLT: ${ttlt}ms, generation: ${gen_time}ms"
          echo "TTLT=$ttlt" >> "$tmpfile"
          break
        fi
      fi
    done

  # Print summary
  if [ -f "$tmpfile" ]; then
    source "$tmpfile" 2>/dev/null
    echo "[$user_id] SUMMARY: TTFT=${TTFT:-timeout}ms, TTLT=${TTLT:-timeout}ms"
  else
    echo "[$user_id] SUMMARY: TIMEOUT or ERROR"
  fi
  rm -f "$tmpfile"
}

echo "============================================"
echo "CONCURRENT MULTI-USER TEST"
echo "3 users, each requesting 1000-word essay"
echo "Started at $(date +%H:%M:%S.%3N)"
echo "============================================"
echo ""

# Launch 3 users simultaneously
run_user "concurrent-user-A" "the history of mathematics" &
PID_A=$!

run_user "concurrent-user-B" "the future of artificial intelligence" &
PID_B=$!

run_user "concurrent-user-C" "the impact of climate change on oceans" &
PID_C=$!

echo "[main] All 3 users launched. Waiting for completion..."
echo ""

wait $PID_A
wait $PID_B
wait $PID_C

echo ""
echo "============================================"
echo "ALL DONE at $(date +%H:%M:%S.%3N)"
echo "============================================"
