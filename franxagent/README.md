# FranxAgent — HSL 全能力复现版

> 用 HSL（Harness Specification Language）复现 [FranxAgent](https://github.com/xhdlphzr/FranxAgent)
> 的**完整会话循环与配套能力**（21 个 HSL 模块）：`tools` 单入口函数调用协议、
> 直接调用自动纠偏、write 提案-审查-批准（Code Review Panel 的后端化身）、
> command 删除禁令、混合检索知识注入、会话记忆沉淀、孤儿 tool 消息清理、
> **time 内建工具、memory() 上下文安全压缩、add_conversation 对话入库、
> 增量索引（check_and_update）、定时任务调度器（tasks.json 轮询/事件多播/取消）**。

## 原架构 → HSL 投影对照

| FranxAgent（原，Python） | 本复现（HSL） | 模块 |
|:---|:---|:---|
| agent.py `input()` 工具循环 | `graph Franx`（AgentLoop G1） | `franxagent.hsl` |
| 单一 `tools` 函数 + tool_name 内层 | `parse_reply` + `ToolRequestNorm` | `agents/router.hsl` |
| 直接调用内建工具名自动纠偏 | 纠偏逻辑 + `corrections` 统计 | `agents/router.hsl` |
| write 提案模式（v5.0.0） | `Proposal` 一等值 + `ApprovalGate` | `tools/fs.hsl` + `agents/approver.hsl` |
| command 删除禁令（rm/del/rmdir/shred） | 黑名单首词拦截 + 移回收站建议 | `tools/command.hsl` |
| knowledge 混合检索（向量+FTS5+RRF） | 三元组重叠 + 关键词 + RRF 融合 | `knowledge/store.hsl` |
| messages.json 持久化 + 孤儿清理 | `clean_orphans` 纯函数 | `memory/persist.hsl` |
| add_skill 即时入库 | `KnowledgeStore::add_skill` | `knowledge/store.hsl` |
| DuckDuckGo 免费搜索 | native fetch html.duckduckgo.com | `tools/search.hsl` |
| knowledge/tools/time（时间内建工具） | `tool_time` + 系统提示词工具说明 | `tools/time.hsl` |
| agent.py `memory()` + `_find_safe_cut_index` | 上下文超限 → 孤儿清理 → 安全切割 → 对半回退 | `memory/compress.hsl` |
| agent.py 上下文超限 except 分支（压缩重试） | llm 软错误识别 → 压缩 → 重建上下文 → continue | `franxagent.hsl` 主图 |
| knowledge/memory.py `add_conversation` | 问答对入知识库 + 时间戳备份 .md | `knowledge/store.hsl` |
| vector.py `check_and_update`（file_versions 增量） | 内容指纹对照的增量索引 + 消失/孤儿清理 | `knowledge/index.hsl` |
| scheduler.py（tasks.json 轮询 + EventBroadcaster） | clock tick 纯函数相位 + 事件多播 + 取消 | `scheduler/{tick,events,execute}.hsl` |

## 拓扑

```
  model ──ToolCalled──> router ──Observed──> model      （工具执行环）
  router ──ProposalReady──> approver                    （write 提案送审）
  model ──Remembered──> store                           （会话记忆沉淀）
```

## 运行（dhv-ts 解释器）

```bash
# 全量回归（check + 3 剧本 + 断言 + emit）
bash run-tests.sh

# 单剧本（确定性，CI 可复现）
cp -r workspace /tmp/franx-ws
bun ../.toolchain/dhv-ts/src/main.ts run franxagent.hsl \
  --workspace /tmp/franx-ws \
  --task "请更新 notes.txt 第 2 行，把 TODO 标记为 DONE" \
  --model scripted \
  --fixture fixtures/fix-notes.json \
  --out /tmp/franx-run

# 上下文压缩剧本（故障注入 llm 超限 → memory() 压缩 → 重试成功）
bun ../.toolchain/dhv-ts/src/main.ts run franxagent.hsl \
  --workspace /tmp/franx-cp-ws --task "更新 notes.txt 第 2 行为 DONE（上下文压力剧本）。" \
  --model scripted --fixture fixtures/fix-compress.json --out /tmp/franx-cp-run

# 定时任务剧本（clock 轨道 5 tick：触发 3 / 去重 1 / 取消 1 / 跨天重触发）
bun ../.toolchain/dhv-ts/src/main.ts run franxagent.hsl \
  --workspace /tmp/franx-sch-ws --task "空闲会话（调度演练）。" \
  --model scripted --fixture fixtures/fix-schedule.json --out /tmp/franx-sch-run
```

实测汇总：fix-notes ✅ 3 turns / 3 tool_calls / corrections 1（直接调用
`write` 触发纠偏）/ proposals 1 approved（提案-审查-批准落盘）/ failures 1
（`rm` 删除禁令拦截）/ memories 1；fix-compress ✅ compressions 1 +
`memory_compressed` 事件 + 压缩恢复后提案照常落盘；fix-schedule ✅
ticks 5 / triggered 3（completed 2 + cancelled 1）/ 同分钟去重 1 /
跨天重触发 1 / task_start·task_chunk·task_done·task_cancel 事件齐备。

## 核心语义（v5.0.0 的 proposal-review-overwrite）

write 工具**从不落盘**：
1. 读取原文件 → 按 mode（overwrite / insert / edit）计算应用后的完整内容；
2. 产出 `Proposal { path, mode, before, after }`；
3. 审查闸门裁决（scripted 剧本轨道 / yolo 自动批 / readonly 全拒）；
4. 批准 → `apply_proposal` 落盘（唯一写盘路径）+ 结果回填模型；
5. 拒绝 → 提案作废，拒绝原因反馈模型。

insert 语义：start_line>0 插到该行之后；否则追加文件末尾。
edit 语义：替换 [start_line, end_line] 闭区间（1 起算）。

## 目录结构（21 个 HSL 模块）

```
franxagent/
├── franxagent.hsl              入口：Franx 主 graph + 调度相位 + project + scale
├── types/
│   ├── messages.hsl            Message / ToolCall / ToolRequest / ToolOutcome / Proposal / Turn
│   ├── state.hsl               FranxConfig（model_track 参数化）/ TurnStats / SessionState / SessionReport
│   └── errors.hsl              LlmError / SafetyError / FranxError + From×3
├── knowledge/
│   ├── store.hsl               混合检索（三元组+关键词+RRF）+ add_skill + add_conversation + 指纹
│   └── index.hsl               增量索引（check_and_update：sidecar + 扫描 + 版本对照）
├── tools/
│   ├── fs.hsl                  read（行号）+ write 三模式提案 + apply_proposal
│   ├── command.hsl             删除禁令（rm/del/rmdir/shred → 移回收站建议）
│   ├── search.hsl              DuckDuckGo HTML 端点检索（native fetch）
│   ├── time.hsl                time 内建工具（当前日期时间 + 星期）
│   └── cap.hsl                 输出封顶
├── agents/
│   ├── router.hsl              tools 单入口协议 + 纠偏 + 工具分发（含 MCP 路径臂）
│   └── approver.hsl            审查闸门（Code Review Panel 后端化身）
├── memory/
│   ├── persist.hsl             孤儿 tool 消息清理
│   └── compress.hsl            memory()：安全切割压缩 + 超限识别
├── scheduler/
│   ├── tick.hsl                tasks.json 轮询匹配 / 每日去重 / active_tasks / 取消
│   ├── events.hsl              EventBroadcaster（task_* 事件多播）
│   └── execute.hsl             execute_task（task_acts 会话 + chunk 流）
├── providers/chat.hsl          ChatModel trait + OpenAIChatModel + ScriptedChatModel（轨道参数化）
├── config/resources.hsl        USER_GUIDE 系统提示词（含 time 工具说明）+ FRANX_CONFIG
├── workspace/                  演示工作区（notes.txt + tasks.json + knowledge/）
├── fixtures/                   fix-notes / fix-compress / fix-schedule（3 剧本）
├── run-tests.sh                全量回归（check + 3 剧本断言 + emit 校验）
└── web/                        原版 Web UI（逐字节拷贝）+ ECIES/JWT/SSE 适配服务器
```

## 已知简化（诚实披露）

- 混合检索的「向量通道」用字符三元组重叠替代 sentence-transformers
  （确定性、零依赖；RRF 融合参数与原实现一致）；
- 审查面板为后端闸门化身（前端 diff 视图不在 HSL 契约层）；
- 流式输出 / thinking 开关收敛为整回合非流式（前端关注点）；
- **MCP stdio 客户端**：config 的 `mcp_servers` 声明与路由层 "server/tool"
  形态转发臂已复现，真实子进程 stdio 协议是部署面（范围外，web 适配层
  README 详述）；Cloudflare Tunnel 同为部署面；
- **调度器**：HSL 侧为 clock tick 纯函数相位（`run_tasks_once`：匹配/去重/
  取消/active_tasks 语义全量），真实时钟线程属 web 适配层
  （scripted 下经 clock 轨道驱动，与原版 run_tasks 每日重触发语义一致）；
- 持久层 sidecar（`knowledge/.vector-store.jsonl`）为 sqlite vectors.db 的
  化身（D/V 行 ≈ vectors/file_versions 表）；mtime 判据 → 内容指纹。

## BNF 特性覆盖

graph + AgentLoop（G1）+ 条件环（G3）/ S6 穷尽 match（ToolCall /
Approval / Turn）/ `?` + From×3 / Option 链 / Vec.remove/insert/append /
String strip_prefix / const Vec 字面量 / native typescript（fs/shell/
json/fixture/fetch 网络）/ block + static 资源 / project + rules + scale /
macro_rules!。

## License

上游 FranxAgent 为 AGPL-3.0；本 HSL 复现按 MIT 发布（仅复现架构语义，
未复制其源码）。
