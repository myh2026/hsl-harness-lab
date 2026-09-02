# MathPhysLab — 数理推演验证 harness

> 毕业论文方向一：**对数学/物理专攻的 harness** —— 被测模型（AI）按
> `Formula → Compute → Claim` 协议提交解题步骤，harness 用**量纲分析、
> 独立重算、合理性检查**三道防线逐步裁决，输出可复核的验证报告。

## 为什么这是"harness"而不是"题库"

这个项目的价值不在解题，而在**验证**。被测的可以是剧本（CI 确定性回归），
也可以是真实 LLM（把 `next_move` 的 fixture 桥换成 `$host.llm.complete`，
图拓扑与计分不变）——这正是 HSL harness 的分层意义：

```
被测模型（可替换） ──Move 协议──▶ 裁决器 judge ──▶ 逐步记录 ──▶ 汇总报告
                                    │
                        量纲表 + 公式库 + 独立重算
                        （ground truth，不信任模型推导路径）
```

三道防线：

| 防线 | 机制 | 抓到的错误类型 |
|:---|:---|:---|
| 量纲分析 | 单位表白名单 + `Dim` 指数代数（M·L·T） | 单位写错 / 量纲失配（`m²` vs `m`） |
| 独立重算 | harness 按公式库自己算一遍，不看模型中间步骤 | 数值幻觉（31.2 vs 29.698） |
| 合理性检查 | 非负性 / 有限性 / 量级上限 | 签号错误 / 爆炸数值 |

## 项目结构

```
mathphys/
├── types.hsl       类型契约层（Dim/Quantity/Problem/Move/Verdict/…）
├── units.hsl       量纲代数与单位解析（纯逻辑，可独立单测）
├── formulas.hsl    公式库 + 题库 + 独立重算（ground truth）
├── verifier.hsl    裁决层：Verdict → StepRecord 展平
├── main.hsl        入口：AgentLoop 分发 + 报告 + 物理层投射
├── fixtures/fix-mixed.json   剧本（注入 2 个模型错误）
└── run-tests.sh    CI 脚本（check + scripted run + 产物断言）
```

## 运行

```bash
# 依赖：bun ≥ 1.1（dhv-ts 零 npm 依赖） + python3（语法校验）
bash run-tests.sh          # 一键：check → 剧本端到端 → 报告断言 → 多后端投射
```

剧本故事线（4 道力学题，注入 2 个错误）：

| # | 步骤 | 裁决 |
|---|---|---|
| 2 | compute 声称 `163.3 m²`（投射 range，量纲应为 L） | ✗ **DimMismatch 捕获**（期望 L^1 实得 L^2） |
| 6 | claim 声称 `31.2 m/s`（自由落体 v=√(2gh)=29.698） | ✗ **NumericError 捕获**（超容差 0.05） |

汇总：4 道题 · 捕获错误 2 · 最终正确 3/4 —— **harness 的价值恰恰是那两个 ✗**。

## 拓扑与观测

`graph MathPhysLab` 三节点（bank/judge + 插件注入位）、三条 Guard 边；
`events.jsonl` 中的 G6 边事件让拓扑行为可断言（`edge(judge→bank on Formula)`
恰好在每次公式提案时触发）。

## 物理层投射

`project {}` 使用 BNF v1.5 规则组：Python 全量平铺（fn/const/graph/类型），
核心协议类型 `Dim/Move/Verdict` 双语言显式投射到 TypeScript，配置块去 YAML。
生成物经语义级验证：`recompute`/`judge_formula_v`/`formula_result_dim` 的
Python 输出与解释器逐位一致（40.8163 / 2.0071 / `Dim(m=0, l=1, t=0)`）。

## 已知边界（诚实清单）

- 函数体含多个早退 `return` 时 python 活体翻译回退 contract（围栏保源，
  manifest 有 `contract_fallbacks` 字段）—— 尾表达式风格的函数全部活体；
- 被测模型换成真实 LLM 需自备 `$host.llm` 网关（dsh 的 DeepSeekModel 模式）；
- `judge` 节点是插件注入位（`()` 单元），微内核部署时由宿主注入实现。
