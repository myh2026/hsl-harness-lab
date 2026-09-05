#!/usr/bin/env bash
# ============================================================================
# StanzaWeaver HSL 复现 — 全量回归（check → 3 剧本端到端 → 断言 → emit）
# 剧本：
#   weave-moon.json  — core 回归（4 工具轮 + 符号层拒绝/受理 + 词库优先检索）
#                      ※ 运行前部署 fixtures/datasets/* 到工作区 datasets/
#                         （zh CC-CEDICT 样例 20 词 + fr Lexique382 样例 10 词）
#   fix-lexicon.json — 新模板路径（la-hexameter 经 config 轨道选择 + 拉丁
#                      音节元音组启发式 + 提交受理）
#   词库面           — vocab_import 事件 / vocabulary.tsv 落盘 / 增量幂等
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
OUT=$(bun "$DHV" check stanzaweaver.hsl 2>&1 | tail -1)
echo "  $OUT"

step "剧本 1/3：core 回归 + 词库优先（weave-moon + datasets）"
rm -rf "$TMP/w1" "$TMP/r1"; mkdir -p "$TMP/w1/datasets"; cp fixtures/datasets/* "$TMP/w1/datasets/"
bun "$DHV" run stanzaweaver.hsl --workspace "$TMP/w1" --task "月夜江天" \
  --model scripted --fixture fixtures/weave-moon.json --out "$TMP/r1" >/dev/null
T=$(grep -oP '(?<=- template: ).*' "$TMP/r1/report.md")
C=$(grep -oP '(?<=- tool_calls: ).*' "$TMP/r1/report.md")
M=$(grep -oP '(?<=- meter_valid: ).*' "$TMP/r1/report.md")
K=$(grep -oP '(?<=- checker_pass: ).*' "$TMP/r1/report.md")
assert "template" "zh-wujue" "$T"
assert "tool_calls" "4" "$C"
assert "meter_valid" "true" "$M"
assert "checker_pass" "true" "$K"
grep -q '"source":"vocab"' "$TMP/r1/events.jsonl" && echo "  ok   search_words 命中词库（source=vocab）" || { echo "  FAIL 词库未命中"; FAIL=1; }
grep -q '"tool":"refine_line","ok":false' "$TMP/r1/events.jsonl" && echo "  ok   符号层拒绝违规 refine（第 2 行平仄）" || { echo "  FAIL 拒绝路径缺失"; FAIL=1; }
grep -q '"name":"vocab_import"' "$TMP/r1/events.jsonl" && echo "  ok   vocab_import 事件" || { echo "  FAIL vocab_import 缺失"; FAIL=1; }
W=$(grep -c "^W" "$TMP/w1/vocabulary.tsv"); assert_ge "词库落盘词条数" "28" "$W"
grep -q "dataset_zh" "$TMP/w1/vocabulary.tsv" && echo "  ok   meta 表登记（幂等判据）" || { echo "  FAIL meta 缺失"; FAIL=1; }

step "词库导入幂等（二次运行跳过已导入数据集）"
rm -rf "$TMP/w2" "$TMP/r2"; cp -r "$TMP/w1" "$TMP/w2"
S2=$(bun "$DHV" run stanzaweaver.hsl --workspace "$TMP/w2" --task "月夜江天" \
  --model scripted --fixture fixtures/weave-moon.json --out "$TMP/r2" 2>&1 | grep -c "已有数据，跳过" || true)
assert_ge "已有数据跳过日志" "2" "$S2"
R2=$(grep -oP '(?<=check_and_update: re-indexed )\d+' "$TMP/r2/report.md" 2>/dev/null || echo 0)
assert_ge "词库词条保留" "28" "$(grep -c '^W' "$TMP/w2/vocabulary.tsv")"

step "剧本 2/3：新模板路径（fix-lexicon：la-hexameter）"
rm -rf "$TMP/w3" "$TMP/r3"; mkdir -p "$TMP/w3/datasets"; cp fixtures/datasets/* "$TMP/w3/datasets/"
bun "$DHV" run stanzaweaver.hsl --workspace "$TMP/w3" --task "arma virumque" \
  --model scripted --fixture fixtures/fix-lexicon.json --out "$TMP/r3" >/dev/null
T=$(grep -oP '(?<=- template: ).*' "$TMP/r3/report.md")
C=$(grep -oP '(?<=- tool_calls: ).*' "$TMP/r3/report.md")
M=$(grep -oP '(?<=- meter_valid: ).*' "$TMP/r3/report.md")
K=$(grep -oP '(?<=- checker_pass: ).*' "$TMP/r3/report.md")
assert "template" "la-hexameter" "$T"
assert "meter_valid" "true" "$M"
assert "checker_pass" "true" "$K"
assert_ge "tool_calls" "2" "$C"

step "emit 静态投射（产物全过语法校验；X-1 跨语言诊断为顾问性）"
EMIT_OUT=$(bun "$DHV" emit stanzaweaver.hsl --out "$TMP/emit" 2>&1 | tail -1 || true)
echo "  $EMIT_OUT"
echo "$EMIT_OUT" | grep -qE "emit 完成：[0-9]+ 个文件（[0-9]+ 个通过语法校验）" && echo "  ok   emit 产物生成" || { echo "  FAIL emit"; FAIL=1; }
N_OUT=$(echo "$EMIT_OUT" | grep -oP '(?<=emit 完成：)[0-9]+')
N_OK=$(echo "$EMIT_OUT" | grep -oP '（[0-9]+(?= 个通过语法校验)' | grep -oP '[0-9]+')
assert_ge "emit 语法校验通过数" "$N_OUT" "$N_OK"
test -f "$TMP/emit/manifest.json" && echo "  ok   manifest.json" || { echo "  FAIL manifest"; FAIL=1; }

if (( FAIL )); then echo "✗ stanzaweaver 回归失败"; exit 1; fi
echo "✓ stanzaweaver 全量回归通过（词库幂等 + 2 剧本 + check + emit）"
