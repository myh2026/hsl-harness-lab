# DeepSeek Harness — HSL 复现版

> 用 HSL（Harness Specification Language）复现 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
> 的 **core spine**：everything-is-a-plugin 装配协议、append-only 会话日志、
> 有序分节系统提示词装配、带守卫的工具注册表、agent-loop 主循环。

## 原架构 → HSL 投影对照

| deepseek-harness（原） | 本复现（HSL） | 模块 |
|:---|:---|:---|
| Cordis ctx + scope（插件向 ctx 注册贡献） | `PluginHost` + `Contribution` 四贡献臂 | `core/plugin.hsl` |
| session 包（append-only 事件日志） | `SessionLog`（只追加，永不改写） | `core/session.hsl` |
| system-prompt 包（有序分节 + 工具 schema + 变量） | `SystemPrompt`（order 定序装配） | `core/prompt.hsl` |
| tools 包（注册表 + 守卫执行管线） | `ToolRegistry`（白名单守卫 + S6 穷尽分发） | `core/registry.hsl` |
| agent-loop 包（turn/step 生命周期） | `graph Dsh`（AgentLoop G1 + 条件环 G3） | `dsh.hsl` |
| dsh-base bundle（默认组合） | `PluginHost::base()`（四插件 spine） | `core/plugin.hsl` |

## 拓扑

```
  model ──ToolRequested──> registry ──Observed──> model   （工具执行环）
  model ──ReviewRequested──> reviewer ──(Revise)──> model （审查打回环）
  model ──TurnLogged──> log                              （事实落日志）
```

环上每条边带 `on Guard`（G3 合法环）；每轮 turn 的模型可见事实
（turn_opened / model_replied / tool_dispatched / tool_guarded /
review_verdict / run_end）全部 append 进 SessionLog。

## 运行（dhv-ts 解释器）

```bash
# 确定性剧本模式（CI 可复现）
cp -r workspace /tmp/dsh-ws
bun ../.toolchain/dhv-ts/src/main.ts run dsh.hsl \
  --workspace /tmp/dsh-ws \
  --task "stats.ts 中 variance() 的分母用错了（应为样本方差 n-1），且 median() 尚未实现。请修复并让 stats.test.ts 全部通过。" \
  --model scripted \
  --fixture fixtures/fix-variance.json \
  --out /tmp/dsh-run

# 真实 LLM 模式（经 z-ai 网关）
bun ../.toolchain/dhv-ts/src/main.ts run dsh.hsl \
  --workspace /tmp/dsh-llm-ws --task "同上" \
  --model deepseek --max-turns 10 --out /tmp/dsh-llm-run

# 静态投射（56 后端文件 + manifest）
bun ../.toolchain/dhv-ts/src/main.ts emit dsh.hsl --out /tmp/dsh-emit
```

实测（剧本模式）：✅ 5 turns / 5 tool_calls / 25 events_logged /
verdict=accepted，工作区 `bun stats.test.ts` 全 PASS。

## 目录结构（15 个 HSL 模块）

```
deepseek-harness/
├── dsh.hsl                     入口：Dsh 主 graph + main + project + scale + bump! 宏
├── types/
│   ├── messages.hsl            Message / ToolCall / Action / Verdict / Step
│   ├── state.hsl               Policy / RunStats / RunState / RunReport
│   ├── events.hsl              SessionEvent（append-only 日志词汇）
│   └── errors.hsl              ProviderError / GuardError / DshError + From×3
├── core/
│   ├── plugin.hsl              PluginHost（everything-is-a-plugin 装配）
│   ├── session.hsl             SessionLog（append-only）
│   ├── prompt.hsl              SystemPrompt（有序分节装配）
│   └── registry.hsl            ToolRegistry（守卫执行管线）
├── providers/model.hsl         ModelProvider trait + DeepSeekModel + ScriptedModel
├── tools/
│   ├── workspace.hsl           read/write/edit/list（路径监狱 + 输出封顶）
│   └── shell.hsl               bash（白名单 + 超时）
├── agents/
│   ├── executor.hsl            严格 JSON 协议解析
│   └── reviewer.hsl            审查闸门
├── config/resources.hsl        SYSTEM_PROMPT / REVIEW_RUBRIC / DSH_CONFIG / EVENTS_SCHEMA
├── workspace/                  待修复任务工作区（stats.ts + 失败测试）
└── fixtures/fix-variance.json  确定性剧本
```

## 六道防线（与原版安全语义对齐）

1. 编译期能力域：`#[capability(file_read/file_write/process_spawn/net_connect)]`
2. 运行时路径监狱：`$host.fs` 越界即抛错
3. bash 白名单：注册表守卫 + 宿主双层
4. 预算闸门：max_turns / max_bash_calls / max_output_chars
5. 协议纠错回路：JSON 违规反馈重试
6. 审查闸门：done 后 reviewer 裁决 Accept / Revise

## BNF 特性覆盖

graph + mut 参数 + 返回类型 / node 声明（带 `?`）/ 条件边环（G3）/
AgentLoop（G1）/ S6 穷尽 match（ToolCall/Action/Verdict/SessionEvent 四处）/
macro_rules! / GraphName::run / native typescript（llm/fs/shell/json）/
block + static + `{{}}` 编译期插值 / `?` + From×3 / turbofish parse::<T>() /
trait + 双 impl / 进制与分隔字面量（`0x0C`、`4_000`）/ project + rules（BNF v1.5）+ scale。

## License

MIT（与上游 HSL 工具链及 deepseek-harness 同许可）
