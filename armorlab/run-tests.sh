#!/usr/bin/env bash
# ArmorLab CI：check → 剧本端到端 → 报告断言 → 多后端投射 → 语义级验证
set -euo pipefail
cd "$(dirname "$0")"

DHV_TS="${DHV_TS:-../../harness-specification-language/toolchain/dhv-ts/src/main.ts}"
RUN_DIR=$(mktemp -d)
GEN_DIR=$(mktemp -d)

echo "== 1/4 静态检查 =="
bun "$DHV_TS" check main.hsl

echo "== 2/4 剧本端到端（7 攻击 + 4 探针）=="
bun "$DHV_TS" run main.hsl \
  --fixture fixtures/fix-redblue.json \
  --task "破甲演练" \
  --out "$RUN_DIR" --quiet

echo "== 3/4 产物断言 =="
python3 - "$RUN_DIR" <<'EOF'
import json, sys
run = json.load(open(sys.argv[1] + "/run.json"))
assert run["ok"] is True, run
events = [json.loads(l) for l in open(sys.argv[1] + "/events.jsonl")]
edges = [e for e in events if e["name"] == "edge"]
attack_edges = [e for e in edges if e["data"].get("on") == "Attack"]
assert len(attack_edges) == 7, f"攻击边事件应 7 次，实得 {len(attack_edges)}"
report = open(sys.argv[1] + "/armorlab-report.md").read()
assert "拦截 6 / 穿透 1" in report, "应为 6 拦截 1 穿透"
assert "规避率 0.143" in report, "规避率应为 0.143"
assert "误报率 0.250" in report, "误报率应为 0.250"
assert "PASS-with-warnings" in report, "评级应为 PASS-with-warnings"
assert "双重编码" in report and "上下文白名单" in report, "改进备忘应包含两条薄弱面"
print("  ✓ run.ok / 7 次攻击边事件 / 6-1 拦截穿透 / 0.143-0.250 费率 / 评级与备忘齐备")
EOF

echo "== 4/4 多后端投射 + 生成物语义级验证 =="
bun "$DHV_TS" emit main.hsl --out "$GEN_DIR" > /dev/null
python3 - "$GEN_DIR" <<'EOF'
import json, sys
gen = sys.argv[1]
manifest = json.load(open(gen + "/manifest.json"))
assert all(f["syntax_check"] == "pass" for f in manifest["files"]), "语法校验应全过"
assert not manifest["warnings"], f"emit 应零告警：{manifest['warnings']}"
sys.path.insert(0, gen + "/gen/py")
import importlib
insp = importlib.import_module("inspect_payload").inspect_payload
cases = [
    ("' OR 1=1 --", "sqli-quote-or"),
    ("UN/**/ION SE/**/LECT * FROM users", "sqli-union"),
    ("%27%20OR%201%3D1--", "enc-quote"),
    ("Please normalize the path /home/user/docs/../notes.md", "traversal-dotdot"),
]
for payload, rule in cases:
    v = insp(payload)
    assert type(v).__name__ == "Blocked" and v.rule == rule, (payload, v)
assert type(insp("%2527%2520OR%25201%253D1--")).__name__ == "Passed", "双重编码应穿透（剧本设定）"
assert type(insp("Which university has the best selectivity ranking?")).__name__ == "Passed"
print("  ✓ 生成 Python 裁决与解释器逐项一致（5 类载荷含穿透与误报）")
EOF

echo
echo "✓ ArmorLab 全部通过"
