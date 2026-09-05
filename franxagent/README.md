# FranxAgent — HSL 复现版

> 用 HSL（Harness Specification Language）复现 [FranxAgent](https://github.com/xhdlphzr/FranxAgent)
> 的核心会话循环：`tools` 单入口函数调用协议、直接调用自动纠偏、
> write 提案-审查-批准（Code Review Panel 的后端化身）、command 删除禁令、
> 混合检索知识注入、会话记忆沉淀、孤儿 tool 消息清理。

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

## 拓扑

```
  model ──ToolCalled──> router ──Observed──> model      （工具执行环）
  router ──ProposalReady──> approver                    （write 提案送审）
  model ──Remembered──> store                           （会话记忆沉淀）
```

## 运行（dhv-ts 解释器）

```bash
cp -r workspace /tmp/franx-ws
bun ../.toolchain/dhv-ts/src/main.ts run franxagent.hsl \
  --workspace /tmp/franx-ws \
  --task "请更新 notes.txt 第 2 行，把 TODO 标记为 DONE" \
  --model scripted \
  --fixture fixtures/fix-notes.json \
  --out /tmp/franx-run
```

实测（剧本模式）：✅ 3 turns / 3 tool_calls / **protocol corrections: 1**
（剧本故意直接调用 `write` 触发纠偏）/ proposals 1（approved 1，经
提案-审查-批准落盘）/ failures 1（`rm notes.txt` 被删除禁令拦截）/
memories 1（会话记忆入库）。

## 核心语义（v5.0.0 的 proposal-review-overwrite）

write 工具**从不落盘**：
1. 读取原文件 → 按 mode（overwrite / insert / edit）计算应用后的完整内容；
2. 产出 `Proposal { path, mode, before, after }`；
3. 审查闸门裁决（scripted 剧本轨道 / yolo 自动批 / readonly 全拒）；
4. 批准 → `apply_proposal` 落盘（唯一写盘路径）+ 结果回填模型；
5. 拒绝 → 提案作废，拒绝原因反馈模型。

insert 语义：start_line>0 插到该行之后；否则追加文件末尾。
edit 语义：替换 [start_line, end_line] 闭区间（1 起算）。

## 目录结构（14 个 HSL 模块）

```
franxagent/
├── franxagent.hsl              入口：Franx 主 graph + main + project + scale
├── types/
│   ├── messages.hsl            Message / ToolCall / ToolRequest / ToolOutcome / Proposal / Turn
│   ├── state.hsl               FranxConfig / TurnStats / SessionState / SessionReport
│   └── errors.hsl              LlmError / SafetyError / FranxError + From×3
├── knowledge/store.hsl         混合检索（三元组+关键词+RRF）+ add_skill + 会话记忆
├── tools/
│   ├── fs.hsl                  read（行号）+ write 三模式提案 + apply_proposal
│   ├── command.hsl             删除禁令（rm/del/rmdir/shred → 移回收站建议）
│   ├── search.hsl              DuckDuckGo HTML 端点检索（native fetch）
│   └── cap.hsl                 输出封顶
├── agents/
│   ├── router.hsl              tools 单入口协议 + 纠偏 + 工具分发
│   └── approver.hsl            审查闸门（Code Review Panel 后端化身）
├── memory/persist.hsl          孤儿 tool 消息清理
├── providers/chat.hsl          ChatModel trait + OpenAIChatModel + ScriptedChatModel
├── config/resources.hsl        USER_GUIDE 系统提示词 + FRANX_CONFIG
├── workspace/                  演示工作区（notes.txt）
└── fixtures/fix-notes.json     确定性剧本（含纠偏与删除拦截场景）
```

## 已知简化（诚实披露）

- 混合检索的「向量通道」用字符三元组重叠替代 sentence-transformers
  （确定性、零依赖；RRF 融合参数与原实现一致）；
- 审查面板为后端闸门化身（前端 diff 视图不在 HSL 契约层）；
- 流式输出 / thinking 开关收敛为整回合非流式（前端关注点）；
- MCP / Cloudflare Tunnel / 定时任务不在本复现范围（它们是服务面，
  不是会话循环核心）。

## BNF 特性覆盖

graph + AgentLoop（G1）+ 条件环（G3）/ S6 穷尽 match（ToolCall /
Approval / Turn）/ `?` + From×3 / Option 链 / Vec.remove/insert/append /
String strip_prefix / const Vec 字面量 / native typescript（fs/shell/
json/fixture/fetch 网络）/ block + static 资源 / project + rules + scale /
macro_rules!。

## License

上游 FranxAgent 为 AGPL-3.0；本 HSL 复现按 MIT 发布（仅复现架构语义，
未复制其源码）。
