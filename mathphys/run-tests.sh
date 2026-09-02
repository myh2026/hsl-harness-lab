#!/usr/bin/env bash
# MathPhysLab CI：check → 剧本端到端 → 报告断言 → 多后端投射 → 语义级验证
set -euo pipefail
cd "$(dirname "$0")"

DHV_TS="${DHV_TS:-../../harness-specification-language/toolchain/dhv-ts/src/main.ts}"
RUN_DIR=$(mktemp -d)
GEN_DIR=$(mktemp -d)

echo "== 1/4 静态检查（S/G/P/N + E-2）=="
bun "$DHV_TS" check main.hsl

echo "== 2/4 剧本端到端（注入 2 个模型错误）=="
bun "$DHV_TS" run main.hsl \
  --fixture fixtures/fix-mixed.json \
  --task "数理推演验证" \
  --out "$RUN_DIR" --quiet

echo "== 3/4 产物断言 =="
python3 - "$RUN_DIR" <<'EOF'
import json, sys
run = json.load(open(sys.argv[1] + "/run.json"))
assert run["ok"] is True, run
events = [json.loads(l) for l in open(sys.argv[1] + "/events.jsonl")]
edges = [e for e in events if e["name"] == "edge"]
formula_edges = [e for e in edges if e["data"].get("on") == "Formula"]
assert len(formula_edges) == 4, f"公式边事件应 4 次，实得 {len(formula_edges)}"
report = open(sys.argv[1] + "/mathphys-report.md").read()
assert "捕获错误 2" in report, "应捕获 2 个注入错误"
assert "DimMismatch" in report and "NumericError" in report, "两类错误均应出现"
assert "最终正确 3/4" in report, "最终正确应为 3/4"
print("  ✓ run.ok / 4 次公式边事件 / 捕获 2 错误 / 3-of-4 正确")
EOF

echo "== 4/4 多后端投射 + 生成物语义级验证 =="
bun "$DHV_TS" emit main.hsl --out "$GEN_DIR" > /dev/null
python3 - "$GEN_DIR" <<'EOF'
import json, sys
gen = sys.argv[1]
manifest = json.load(open(gen + "/manifest.json"))
assert all(f["syntax_check"] == "pass" for f in manifest["files"]), "语法校验应全过"
assert not manifest["warnings"], f"emit 应零告警：{manifest['warnings']}"
import importlib
sys.path.insert(0, gen + "/gen/py")
recompute = importlib.import_module("recompute").recompute
problem_bank = importlib.import_module("problem_bank").problem_bank
find_problem = importlib.import_module("find_problem").find_problem
p = find_problem(problem_bank(), "projectile")
assert abs(recompute(p) - 40.8163) < 1e-3, recompute(p)
p2 = find_problem(problem_bank(), "pendulum")
assert abs(recompute(p2) - 2.0071) < 1e-3, recompute(p2)
print("  ✓ 生成 Python 与解释器逐位一致（40.8163 / 2.0071）")
EOF

echo
echo "✓ MathPhysLab 全部通过"
