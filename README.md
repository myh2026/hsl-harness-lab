# HSL Harness Lab — 毕业论文 harness 实验场

[![CI](https://github.com/myh2026/hsl-harness-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/myh2026/hsl-harness-lab/actions/workflows/ci.yml)

> 用 [HSL（Harness Specification Language）](https://github.com/myh2026/harness-specification-language)
> 实测撰写的 harness 实验场：两个自研方向 + 三个生产级 harness 的 HSL 严格复现 + 一份语法舒适度评估报告。
> 目标：为毕业论文的两个候选方向提供可运行的实验基线。

## 内容

| 目录 | 论文方向 | 一句话 | CI |
|:---|:---|:---|:---|
| `mathphys/` | 数理专攻 harness | 被测模型提交 Formula→Compute→Claim 解题步骤，harness 用量纲分析 + 独立重算 + 合理性检查逐步裁决（4 道力学题注入 2 个错误，全部捕获） | `bash mathphys/run-tests.sh` |
| `armorlab/` | 网安破甲 harness（红蓝对抗） | 红队载荷 vs 蓝方防火墙，同时计量规避率与误报率，输出装甲评级与薄弱面备忘（7 攻击 6 拦截 1 穿透 + 1 误报） | `bash armorlab/run-tests.sh` |
| `SYNTAX-REVIEW.md` | — | 语法舒适度实测评估（~700 行 HSL 撰写体验 + 8 个工具链缺陷实录 + 修复验证） | — |
| `deepseek-harness/` | 生产级 harness 复现 | 用 HSL 严格复现 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 core spine + 全工具面（everything-is-a-plugin / append-only 会话日志 / 有序分节系统提示词 / 守卫工具注册表 / agent-loop），含原版 Web UI 视觉复刻 | `bash deepseek-harness/run-tests.sh` |
| `franxagent/` | 生产级 harness 复现 | 用 HSL 严格复现 [xhdlphzr/FranxAgent](https://github.com/xhdlphzr/FranxAgent)（单入口 `tools` 协议 / write 提案-审查-批准 / command 删除禁令 / RRF 混合检索 / 上下文安全压缩 / 定时任务），含原版 Web UI（逐字节拷贝） | `bash franxagent/run-tests.sh` |
| `stanzaweaver/` | 生产级 harness 复现 | 用 HSL 严格复现 [xhdlphzr/StanzaWeaver](https://github.com/xhdlphzr/StanzaWeaver)（神经-符号四步流水线 / 逐字平仄韵脚校验 / 五语言模板 / 词库检索），含原版 Web UI（逐字节拷贝） | `bash stanzaweaver/run-tests.sh` |

CI：push / PR 即时回归 + **每 15 分钟定时全链回归**（兄弟检出工具链仓库 main 分支——工具链升级 15 分钟内在此现形）；失败自动开 `scheduled-test-failure` 标签 Issue，恢复全绿自动评论并关闭。

## 环境要求

- bun ≥ 1.1（运行 dhv-ts，零 npm 依赖）
- python3 ≥ 3.8（生成物语法校验与语义级验证）

默认 `run-tests.sh` 以 `../../harness-specification-language/` 为工具链
位置（与 [harness-specification-language](https://github.com/myh2026/harness-specification-language)
仓库同级检出时开箱即用）；自定义路径：

```bash
DHV_TS=/path/to/hsl/toolchain/dhv-ts/src/main.ts bash mathphys/run-tests.sh
```

## 两个项目的共同架构（论文叙事）

- **可替换被测方**：剧本模式（CI 确定性）↔ 真实 LLM（`$host.llm` 网关），
  图拓扑与计分不变 —— dsh 的 ModelProvider 模式；
- **协议在 fn、分发在 loop**：`Move` 枚举三/四变体，AgentLoop 内 S-6
  铁律强制显式穷尽，裁决逻辑收敛到普通函数层；
- **拓扑可观测**：`events.jsonl` 的 G6 边事件进 CI 断言（公式边恰 4 次 /
  攻击边恰 7 次）；
- **多后端投射可信**：BNF v1.5 `rules {}` 规则组批量投射，生成 Python
  经 exec 语义级验证与解释器逐位一致；
- **诚实边界**：多早退 return 的函数回退 contract（manifest 有
  `contract_fallbacks` 字段），README 逐项列出已知边界。

## 与工具链的共生关系

本实验场在实测中触发了 dhv-ts 0.2.51 修复批次的全部 8 个缺陷
（详见 `SYNTAX-REVIEW.md` §4），修复后：

- `tests/hsl/run-all.ts` 110 用例全绿；
- 两个项目的生成物全链语义一致；
- IDE 扩展（v0.1.1）校验脚本 `ide/tests/validate.js` 全绿。


## 生产级 harness 复现（deepseek-harness / FranxAgent / StanzaWeaver）

三个目录用 HSL 逐能力复现三个开源 harness 项目，`check` 0 error 0 warning，
全部带确定性剧本（scripted model + fixture）端到端回归与 `emit` 投射验证：

| 目录 | 原项目 | 复现规模 | 压缩率 | 回归 |
|:---|:---|:---|:---|:---|
| `deepseek-harness/` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 15+ HSL 模块 | ~94% | 剧本 5 turns / 5 tool_calls / verdict=accepted |
| `franxagent/` | [xhdlphzr/FranxAgent](https://github.com/xhdlphzr/FranxAgent) | 14+ HSL 模块 | ~73% | 剧本含纠偏/提案批准/删除拦截/检索注入 |
| `stanzaweaver/` | [xhdlphzr/StanzaWeaver](https://github.com/xhdlphzr/StanzaWeaver) | 9+ HSL 模块 | ~82% | 剧本 4 工具轮 + 符号层拒绝/受理 |

每个目录内：`*.hsl` 源码 + `README.md`（原架构→HSL 投影对照表 + 已知偏差披露）+
`web/`（原版 UI 复刻 + Bun 适配服务器）+ `fixtures/`（确定性剧本）。

`.toolchain/` 为 vendored dhv-ts 参考解释器（已包含 `toolchain-patches/`
中的两处上游 bug 修复：`mut self` 解析 + native 块正则字面量），
克隆本仓库即可直接 `bun .toolchain/dhv-ts/src/main.ts check <project>/<entry>.hsl`，
无需另外检出工具链仓库。

压缩率口径与统计脚本见 `stats/`（原始后端源码字符数 → HSL 源码字符数，
不含两端 web UI 与测试资产）。
