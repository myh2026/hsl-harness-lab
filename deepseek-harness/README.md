# DeepSeek Harness — HSL 全能力复现版

> 用 HSL（Harness Specification Language）复现 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
> 的 **dsh-base bundle 全能力面**（38 个 HSL 模块）：core spine（everything-is-a-plugin
> 装配 / append-only 会话日志 / 有序分节系统提示词 / 守卫工具注册表 / agent-loop）+
> 全部模型可见工具 + 回路级能力（门禁管线 / compaction / 斜杠命令 / checkpoint /
> token 计量 / todo 投影 / skill 目录 / goal 回合驱动 / repeat 提醒 / jobs 通知 /
> 反馈工件 / user-questions 协议）。

## 原架构 → HSL 投影对照（core spine）

| deepseek-harness（原） | 本复现（HSL） | 模块 |
|:---|:---|:---|
| Cordis ctx + scope（插件向 ctx 注册贡献） | `PluginHost` + `Contribution` 四贡献臂 | `core/plugin.hsl` |
| session 包（append-only 事件日志） | `SessionLog`（只追加，永不改写） | `core/session.hsl` |
| system-prompt 包（有序分节 + 工具 schema + 变量） | `SystemPrompt`（order 定序装配） | `core/prompt.hsl` |
| tools 包（注册表 + 守卫执行管线） | `ToolRegistry`（白名单守卫 + S6 穷尽分发） | `core/registry.hsl` |
| agent-loop 包（turn/step 生命周期） | `graph Dsh`（AgentLoop G1 + 条件环 G3） | `dsh.hsl` |
| dsh-base bundle（默认组合） | `PluginHost::base()`（四插件 spine） | `core/plugin.hsl` |

## 能力矩阵（dsh-base 插件清单 → HSL 模块 → 测试）

| 原版插件 | 能力 | HSL 模块 | 测试剧本 |
|:---|:---|:---|:---|
| tool-fs | read / write / edit / list / read_image* | `tools/workspace.hsl` `tools/image.hsl` | fix-variance / fix-tools |
| tool-fs-search | glob / grep | `tools/search.hsl` | fix-tools |
| tool-str-replace-editor | view/create/str_replace/insert 命令式编辑器 | `tools/editor.hsl` | fix-tools |
| tool-bash | bash（首词白名单 + 超时 + 封顶） | `tools/shell.hsl` | fix-variance |
| tool-todo | TodoWrite + 上下文投影注入 | `tools/todo.hsl` | fix-loop |
| tool-skill | skills 目录发现 / 按名调用 / 目录注入提示词 | `tools/skill.hsl` | fix-tools（+目录注入） |
| tool-goal + goal-round-driver | goal 创建/更新 + 回合自动续行 | `tools/goal.hsl` | check + 主环接线 |
| tool-web + web_search_deepseek + web_fetch_http | web_search / web_fetch（provider 声明层） | `tools/web.hsl` | fix-tools |
| subagent + spawn-in-process | 进程内子代理（独立会话切片 + 嵌套 agent-loop） | `tools/subagent.hsl` | fix-tools |
| tool-jobs | job_spawn / job_output / job_list / job_kill | `tools/jobs.hsl` | fix-tools |
| tool-ralph | ralph 自主循环（代表性实现） | `tools/ralph.hsl` | check |
| tool-workflow | workflow 步骤执行（worker 模型） | `tools/workflow.hsl` | check |
| tool-reminder | repeat-tool 同参重复提醒 | `loop/repeat.hsl` | fix-compact |
| compaction + command-compact + tool-result-pruner | 压力检测 → pruner 剪枝 → 摘要压缩；/compact 按需 | `loop/compaction.hsl` | fix-compact |
| plan-mode | 计划模式写门禁 → done=呈交计划 → 审批 | `loop/planmode.hsl` | fix-loop |
| user-approval | 敏感动作一次性 allow/reject 审批门 | `loop/approval.hsl` | fix-loop |
| session-checkpoint-policy | 变异前快照 + /restore 回滚 | `loop/checkpoint.hsl` | fix-loop |
| token-meter | 累计 token 计量（chars/4 口径） | `loop/tokens.hsl` | 全剧本（report） |
| tool-call-timeout-policy | 每工具协作截止线 | `loop/timeout.hsl` | shell 预算 |
| commands + command-compact/feedback/goal | /compact /feedback /goal /plan /restore /<skill> | `loop/commands.hsl` `loop/channel.hsl` | fix-loop |
| user-questions | ask_user 提问协议（answers 通道） | `tools/questions.hsl` | fix-tools |
| feedback | 反馈工件（评语不进模型历史，运行结束落盘） | `loop/feedback.hsl` | fix-loop |
| interaction（输入侧） | 用户输入通道（fixture user 轨道） | `loop/channel.hsl` | fix-loop |
| llm / llm-retry / deepseek 扩展 | DeepSeekModel + ScriptedModel（轨道化） | `providers/model.hsl` | 全剧本 |
| reviewer | 审查闸门（Accept / Revise） | `agents/reviewer.hsl` | fix-variance |
| session-persistence-jsonl / projection / query-sqlite / title / storage / settings / credentials / sandbox* / subprocess / spill / typert / telemetry / mcp / lsp / acp / webhook / schedule / e2b / terminal / identity / host / boot / attachment / api / sdk / code-runtime | ⚪ 平台基建层（进程模型/持久化后端/外部协议），非 harness 语义核心，范围外（见下「已知边界」） | — | — |

\* read_image 为受限实现：宿主无图像解码通道，返回元信息 + 披露而非伪造内容。

## 拓扑

```
  model ──ToolRequested──> registry（门禁管线：plan门→审批→checkpoint→timeout 包裹守卫分发）
  registry ──Observed──> model   （观察回填）
  model ──ReviewRequested──> reviewer ──(Revise)──> model （审查打回环）
  model ──TurnLogged──> log      （每轮事实 append）
```

## 运行（dhv-ts 解释器）

```bash
# 全量回归（check + 4 剧本 + 断言 + emit）
bash run-tests.sh

# 单剧本（确定性，CI 可复现）
cp -r workspace /tmp/dsh-ws
bun ../.toolchain/dhv-ts/src/main.ts run dsh.hsl \
  --workspace /tmp/dsh-ws \
  --task "stats.ts 中 variance() 的分母用错了（应为样本方差 n-1），且 median() 尚未实现。请修复并让 stats.test.ts 全部通过。" \
  --model scripted --fixture fixtures/fix-variance.json --out /tmp/dsh-run

# 上下文压力剧本（compaction 触发）
DSH_COMPACT_THRESHOLD=6000 bun ../.toolchain/dhv-ts/src/main.ts run dsh.hsl \
  --workspace /tmp/dsh-cp-ws --task "上下文压力演练。" \
  --model scripted --fixture fixtures/fix-compact.json --out /tmp/dsh-cp-run

# 静态投射（195 个后端文件 + manifest）
bun ../.toolchain/dhv-ts/src/main.ts emit dsh.hsl --out /tmp/dsh-emit
```

实测汇总：fix-variance ✅ 5 turns / 5 tool_calls / accepted / 测试全 PASS；
fix-tools ✅ 17 tool_calls / 0 failures / subagents=1 / jobs=1；
fix-loop ✅ plan 门禁 1 / 审批 1 / checkpoint 1 / /restore 回滚生效 / feedback 工件落盘；
fix-compact ✅ compactions=1 / repeat 提醒 1 / 摘要入转录。

## 目录结构（38 个 HSL 模块）

```
deepseek-harness/
├── dsh.hsl                     入口：Dsh 主 graph + main + project + scale + bump! 宏
├── types/                      messages / state / events / errors（封闭枚举四件套）
├── core/                       plugin / session / prompt / registry / gates（门禁管线）
├── loop/                       channel / commands / planmode / approval / checkpoint /
│                               compaction / tokens / repeat / feedback / timeout
├── tools/                      workspace / shell / search(glob+grep) / editor(str-replace) /
│                               todo / skill / goal / web / subagent / jobs / ralph /
│                               workflow / questions / image
├── agents/                     executor（严格 JSON 协议）/ reviewer（审查闸门）
├── providers/model.hsl         ModelProvider + DeepSeekModel + ScriptedModel
├── config/resources.hsl        SYSTEM_PROMPT / REVIEW_RUBRIC / DSH_CONFIG / EVENTS_SCHEMA
├── workspace/                  待修复任务工作区（stats.ts + 失败测试 + skills/ + logo.png）
├── fixtures/                   fix-variance / fix-tools / fix-loop / fix-compact（4 剧本）
├── run-tests.sh                全量回归（check + 4 剧本断言 + emit 校验）
└── web/                        原版 Web UI 复刻 + Bun 适配服务器（见 web/README.md）
```

## 已知边界（诚实披露）

1. **平台基建层范围外**：session 持久化后端（jsonl/sqlite/projection）、storage、
   settings、credentials、sandbox 执行器、subprocess/terminal 进程模型、spill、
   typert、telemetry(otel)、mcp/lsp/acp/webhook 外部协议、e2b、attachment、
   api/sdk 面层、boot/profile 组合器——这些是 dsh-base 的平台装配设施而非
   harness 语义核心；其可观察行为（预算/白名单/审批/日志）已由等价机制覆盖。
2. **web_search / web_fetch**：宿主无 http 出口，实现为 provider 声明层
   （scripted：fixture 轨道；真实模式需网关，观察文案披露「外部来源不可信」语义）。
3. **read_image**：宿主无图像解码/多模态通道 → 元信息 + 受限披露（不伪造）。
4. **jobs**：宿主无线程/进程级后台原语，job_spawn 采取「登记-执行-结算」
   同步语义（job 表 + 状态 + 完成通知注入一致）。
5. **用户输入通道**：真实模式（交互 UI）无 fixture → poll 恒空；
   剧本模式经 user 轨道驱动（含斜杠命令）。
6. **emit 的 X-1 跨语言诊断**为顾问性警告（混合语言 project 声明固有），
   产物 195 文件全部通过语法校验。

## 六道防线（与原版安全语义对齐）

1. 编译期能力域：`#[capability(file_read/file_write/process_spawn/net_connect)]`
2. 运行时路径监狱：`$host.fs` 越界即抛错
3. bash 白名单：注册表守卫 + 宿主双层
4. 预算闸门：max_turns / max_bash_calls / max_output_chars / tool_timeout
5. 协议纠错回路：JSON 违规反馈重试
6. 审查闸门：done 后 reviewer 裁决 Accept / Revise

## BNF 特性覆盖

graph + mut 参数 + 返回类型 / node 声明（带 `?`）/ 条件边环（G3）/
AgentLoop（G1）/ S6 穷尽 match（ToolCall 19 变体 / Action / Verdict / SessionEvent）/
macro_rules! / GraphName::run / native typescript（llm/fs/shell/json/fixture 轨道）/
block + static + `{{}}` 编译期插值 / `?` + From×3 / turbofish parse::<T>() /
trait + 双 impl / 进制与分隔字面量（`0x0C`、`4_000`）/
project + rules（BNF v1.5）+ scale / async fn + await。

## License

MIT（与上游 HSL 工具链及 deepseek-harness 同许可）
