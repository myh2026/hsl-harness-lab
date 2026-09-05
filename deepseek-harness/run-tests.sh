#!/usr/bin/env bash
# ============================================================================
# deepseek-harness HSL 复现 — 全量回归（check → 4 剧本端到端 → 断言 → emit）
# 剧本：
#   fix-variance.json — core spine 回归（5 turns / 5 tool_calls / accepted）
#   fix-tools.json    — 全工具面（fs+glob/grep+str_replace_editor+todo+skill
#                        +web+ask_user+subagent+jobs+read_image，17 调用 0 失败）
#   fix-loop.json     — 回路能力（plan 门禁→审批放行→todo→checkpoint→/restore）
#   fix-compact.json  — 上下文压力（pruner + compaction 摘要，DSH_COMPACT_THRESHOLD=6000）
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
OUT=$(bun "$DHV" check dsh.hsl 2>&1 | tail -1)
echo "  $OUT"

step "剧本 1/4：core spine（fix-variance）"
rm -rf "$TMP/w1" "$TMP/r1"; cp -r workspace "$TMP/w1"
bun "$DHV" run dsh.hsl --workspace "$TMP/w1" \
  --task "stats.ts 中 variance() 的分母用错了（应为样本方差 n-1），且 median() 尚未实现。请修复并让 stats.test.ts 全部通过。" \
  --model scripted --fixture fixtures/fix-variance.json --out "$TMP/r1" >/dev/null
V=$(grep -oP '(?<=- verdict: ).*' "$TMP/r1/report.md")
T=$(grep -oP '(?<=- turns: ).*' "$TMP/r1/report.md")
C=$(grep -oP '(?<=- tool_calls: ).*' "$TMP/r1/report.md")
F=$(grep -oP '(?<=- failures: ).*' "$TMP/r1/report.md")
assert "verdict" "accepted" "$V"
assert "turns" "5" "$T"
assert "tool_calls" "5" "$C"
assert "failures" "0" "$F"
(cd "$TMP/w1" && bun stats.test.ts >/dev/null 2>&1) && echo "  ok   stats.test.ts 全 PASS" || { echo "  FAIL stats.test.ts"; FAIL=1; }

step "剧本 2/4：全工具面（fix-tools）"
rm -rf "$TMP/w2" "$TMP/r2"; cp -r workspace "$TMP/w2"
bun "$DHV" run dsh.hsl --workspace "$TMP/w2" --task "演练新工具面。" \
  --model scripted --fixture fixtures/fix-tools.json --out "$TMP/r2" >/dev/null
V=$(grep -oP '(?<=- verdict: ).*' "$TMP/r2/report.md")
C=$(grep -oP '(?<=- tool_calls: ).*' "$TMP/r2/report.md")
F=$(grep -oP '(?<=- failures: ).*' "$TMP/r2/report.md")
S=$(grep -oP '(?<=- subagents: ).*' "$TMP/r2/report.md")
J=$(grep -oP '(?<=- jobs: ).*' "$TMP/r2/report.md")
assert "verdict" "accepted" "$V"
assert "tool_calls" "17" "$C"
assert "failures" "0" "$F"
assert "subagents" "1" "$S"
assert "jobs" "1" "$J"
grep -q "DONE exercised new tools" "$TMP/w2/tools-log.md" && echo "  ok   str_replace_editor 落盘生效" || { echo "  FAIL str_replace_editor 未生效"; FAIL=1; }

step "剧本 3/4：回路能力（fix-loop：plan/审批/todo/checkpoint/restore/feedback）"
rm -rf "$TMP/w3" "$TMP/r3"; cp -r workspace "$TMP/w3"
bun "$DHV" run dsh.hsl --workspace "$TMP/w3" --task "回路能力演练。" \
  --model scripted --fixture fixtures/fix-loop.json --out "$TMP/r3" >/dev/null
V=$(grep -oP '(?<=- verdict: ).*' "$TMP/r3/report.md")
G=$(grep -oP '(?<=- guarded: ).*' "$TMP/r3/report.md")
A=$(grep -oP '(?<=- approvals: ).*' "$TMP/r3/report.md")
K=$(grep -oP '(?<=- checkpoints: ).*' "$TMP/r3/report.md")
assert "verdict" "accepted" "$V"
assert "plan 门禁 guarded" "1" "$G"
assert "审批 approvals" "1" "$A"
assert "检查点 checkpoints" "1" "$K"
grep -q "TODO: 缺失 median" "$TMP/w3/stats.ts" && echo "  ok   /restore 回滚生效（stats.ts 仍为初始态）" || { echo "  FAIL /restore 未回滚"; FAIL=1; }
grep -q "behaved as specified" "$TMP/r3/feedback.log" && echo "  ok   /feedback 工件落盘" || { echo "  FAIL feedback 工件缺失"; FAIL=1; }

step "剧本 4/4：上下文压力（fix-compact，阈值 6000）"
rm -rf "$TMP/w4" "$TMP/r4"; cp -r workspace "$TMP/w4"
DSH_COMPACT_THRESHOLD=6000 bun "$DHV" run dsh.hsl --workspace "$TMP/w4" --task "上下文压力演练。" \
  --model scripted --fixture fixtures/fix-compact.json --out "$TMP/r4" >/dev/null
V=$(grep -oP '(?<=- verdict: ).*' "$TMP/r4/report.md")
M=$(grep -oP '(?<=- compactions: ).*' "$TMP/r4/report.md")
R=$(grep -oP '(?<=- reminders: ).*' "$TMP/r4/report.md")
assert "verdict" "accepted" "$V"
assert "compactions" "1" "$M"
assert_ge "repeat 提醒" "1" "$R"
grep -q "\[compacted\]" "$TMP/r4/transcript.jsonl" && echo "  ok   摘要消息入转录" || { echo "  FAIL 摘要缺失"; FAIL=1; }

step "emit 静态投射（产物全过语法校验；X-1 跨语言诊断为顾问性）"
EMIT_OUT=$(bun "$DHV" emit dsh.hsl --out "$TMP/emit" 2>&1 | tail -1 || true)
echo "  $EMIT_OUT"
echo "$EMIT_OUT" | grep -qE "emit 完成：[0-9]+ 个文件（[0-9]+ 个通过语法校验）" && echo "  ok   emit 产物生成" || { echo "  FAIL emit"; FAIL=1; }
N_OUT=$(echo "$EMIT_OUT" | grep -oP '(?<=emit 完成：)[0-9]+')
N_OK=$(echo "$EMIT_OUT" | grep -oP '（[0-9]+(?= 个通过语法校验)' | grep -oP '[0-9]+')
assert_ge "emit 语法校验通过数" "$N_OUT" "$N_OK"
test -f "$TMP/emit/manifest.json" && echo "  ok   manifest.json" || { echo "  FAIL manifest"; FAIL=1; }

if (( FAIL )); then echo "✗ deepseek-harness 回归失败"; exit 1; fi
echo "✓ deepseek-harness 全量回归通过（4 剧本 + check + emit）"
