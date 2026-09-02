# HSL Harness Lab — 毕业论文 harness 实验场

> 用 [HSL（Harness Specification Language）](https://github.com/myh2026/harness-specification-language)
> 实测撰写的两个 harness 项目 + 一份语法舒适度评估报告。
> 目标：为毕业论文的两个候选方向提供可运行的实验基线。

## 内容

| 目录 | 论文方向 | 一句话 | CI |
|:---|:---|:---|:---|
| `mathphys/` | 数理专攻 harness | 被测模型提交 Formula→Compute→Claim 解题步骤，harness 用量纲分析 + 独立重算 + 合理性检查逐步裁决（4 道力学题注入 2 个错误，全部捕获） | `bash mathphys/run-tests.sh` |
| `armorlab/` | 网安破甲 harness（红蓝对抗） | 红队载荷 vs 蓝方防火墙，同时计量规避率与误报率，输出装甲评级与薄弱面备忘（7 攻击 6 拦截 1 穿透 + 1 误报） | `bash armorlab/run-tests.sh` |
| `SYNTAX-REVIEW.md` | — | 语法舒适度实测评估（~700 行 HSL 撰写体验 + 8 个工具链缺陷实录 + 修复验证） | — |

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
