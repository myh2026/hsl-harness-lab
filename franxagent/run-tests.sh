#!/usr/bin/env bash
# ============================================================================
# FranxAgent HSL 复现 — 全量回归（check → 3 剧本端到端 → 断言 → emit）
# 剧本：
#   fix-notes.json    — core 回归（纠偏/提案批准/删除拦截/记忆/增量索引）
#   fix-compress.json — 上下文超限故障注入 → memory() 安全压缩 → 重试成功
#   fix-schedule.json — 定时任务（触发/同分钟去重/取消/跨天重触发）
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
DHV=../.toolchain/dhv-ts/src/main.ts
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL=0

step() { echo "── $1"; }
assert() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "  ok   $1 = $3"; else echo "  FAIL $1 期望 $2 实得 $3"; FAIL=1; fi
}
assert_ge() { # name min actual
  if (( "$3" >= "$2" )); then echo "  ok   $1 >= $2 (实得 $3)"; else echo "  FAIL $1 期望 >= $2 实得 $3"; FAIL=1; fi
}

step "静态检查（0 error 0 warning）"
OUT=$(bun "$DHV" check franxagent.hsl 2>&1 | tail -1)
echo "  $OUT"

step "剧本 1/3：core 回归（fix-notes）"
rm -rf "$TMP/w1" "$TMP/r1"; cp -r workspace "$TMP/w1"
bun "$DHV" run franxagent.hsl --workspace "$TMP/w1" \
  --task "请更新 notes.txt 第 2 行，把 TODO 标记为 DONE" \
  --model scripted --fixture fixtures/fix-notes.json --out "$TMP/r1" >/dev/null
V=$(grep -oP '(?<=- verdict: ).*' "$TMP/r1/report.md")
C=$(grep -oP '(?<=- protocol corrections: ).*' "$TMP/r1/report.md")
P=$(grep -oP '(?<=- proposals: ).*' "$TMP/r1/report.md" | grep -oP '^\d+')
M=$(grep -oP '(?<=- memories: ).*' "$TMP/r1/report.md")
assert "verdict" "replied" "$V"
assert "纠偏 corrections" "1" "$C"
assert "提案 proposals" "1" "$P"
assert_ge "记忆 memories" "1" "$M"
grep -q "\[DONE\]" "$TMP/w1/notes.txt" && echo "  ok   notes.txt 真实更新" || { echo "  FAIL notes.txt 未更新"; FAIL=1; }
ls "$TMP/w1/knowledge/memories" | grep -q "^[0-9]*\.md$" && echo "  ok   对话记忆备份落盘" || { echo "  FAIL 记忆备份缺失"; FAIL=1; }
grep -q "tool_call" "$TMP/r1/events.jsonl" && echo "  ok   SSE tool_call 事件" || { echo "  FAIL tool_call 事件缺失"; FAIL=1; }

step "剧本 2/3：上下文压缩（fix-compress：故障注入 llm 超限）"
rm -rf "$TMP/w2" "$TMP/r2"; cp -r workspace "$TMP/w2"
bun "$DHV" run franxagent.hsl --workspace "$TMP/w2" \
  --task "更新 notes.txt 第 2 行为 DONE（上下文压力剧本）。" \
  --model scripted --fixture fixtures/fix-compress.json --out "$TMP/r2" >/dev/null
V=$(grep -oP '(?<=- verdict: ).*' "$TMP/r2/report.md")
Z=$(grep -oP '(?<=- context compressions: ).*' "$TMP/r2/report.md")
assert "verdict" "replied" "$V"
assert "压缩次数" "1" "$Z"
grep -q "memory_compressed" "$TMP/r2/events.jsonl" && echo "  ok   memory_compressed 事件" || { echo "  FAIL 压缩事件缺失"; FAIL=1; }
grep -q "\[DONE\]" "$TMP/w2/notes.txt" && echo "  ok   压缩恢复后提案照常落盘" || { echo "  FAIL 压缩后写盘失败"; FAIL=1; }

step "剧本 3/3：定时任务（fix-schedule）"
rm -rf "$TMP/w3" "$TMP/r3"; cp -r workspace "$TMP/w3"
bun "$DHV" run franxagent.hsl --workspace "$TMP/w3" \
  --task "空闲会话（调度演练）。" \
  --model scripted --fixture fixtures/fix-schedule.json --out "$TMP/r3" >/dev/null
V=$(grep -oP '(?<=- verdict: ).*' "$TMP/r3/report.md")
T=$(grep -oP '(?<=- clock ticks: ).*' "$TMP/r3/report.md")
G=$(grep -oP '(?<=- triggered: ).*' "$TMP/r3/report.md" | grep -oP '^\d+')
G2=$(grep -oP '(?<=- triggered: ).*' "$TMP/r3/report.md" | grep -oP '(?<=completed )\d+')
G3=$(grep -oP '(?<=- triggered: ).*' "$TMP/r3/report.md" | grep -oP '(?<=cancelled )\d+')
D=$(grep -oP '(?<=- dedup skipped \(same-minute re-poll\): ).*' "$TMP/r3/report.md")
assert "verdict" "replied" "$V"
assert "clock ticks" "5" "$T"
assert "triggered" "3" "$G"
assert "completed" "2" "$G2"
assert "cancelled" "1" "$G3"
assert "同分钟去重" "1" "$D"
grep -q "task_start" "$TMP/r3/events.jsonl" && echo "  ok   task_start 事件" || { echo "  FAIL task_start 缺失"; FAIL=1; }
grep -q "task_cancel" "$TMP/r3/events.jsonl" && echo "  ok   task_cancel 事件" || { echo "  FAIL task_cancel 缺失"; FAIL=1; }
grep -q "task_done" "$TMP/r3/events.jsonl" && echo "  ok   task_done 事件" || { echo "  FAIL task_done 缺失"; FAIL=1; }

step "emit 静态投射（产物全过语法校验；X-1 跨语言诊断为顾问性）"
EMIT_OUT=$(bun "$DHV" emit franxagent.hsl --out "$TMP/emit" 2>&1 | tail -1 || true)
echo "  $EMIT_OUT"
echo "$EMIT_OUT" | grep -qE "emit 完成：[0-9]+ 个文件（[0-9]+ 个通过语法校验）" && echo "  ok   emit 产物生成" || { echo "  FAIL emit"; FAIL=1; }
N_OUT=$(echo "$EMIT_OUT" | grep -oP '(?<=emit 完成：)[0-9]+')
N_OK=$(echo "$EMIT_OUT" | grep -oP '（[0-9]+(?= 个通过语法校验)' | grep -oP '[0-9]+')
assert_ge "emit 语法校验通过数" "$N_OUT" "$N_OK"
test -f "$TMP/emit/manifest.json" && echo "  ok   manifest.json" || { echo "  FAIL manifest"; FAIL=1; }

if (( FAIL )); then echo "✗ franxagent 回归失败"; exit 1; fi
echo "✓ franxagent 全量回归通过（3 剧本 + check + emit）"
