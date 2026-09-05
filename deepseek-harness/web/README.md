# DSH web/ — 原版壳拷贝 + HSL 复现版视觉复刻 + 适配层

```
web/
├── shell/     原仓库 apps/web 的逐字拷贝（只读，勿改；vite 前端壳）
│   ├── index.html / public/{favicon.svg,manifest.webmanifest} / src/main.ts
├── replica/   本任务产物：DSH web UI 的忠实视觉复刻（纯 vanilla，无构建步骤）
│   ├── index.html   boot 页 + AppFrame（侧栏 | 中列）+ ConversationRoot 骨架
│   ├── app.css      设计令牌（--dsw-*，明暗两套）+ 全部组件样式
│   ├── app.js       boot 序列 / 主题切换 / 会话内存态 / 消息渲染 / composer
│   └── logo.svg     鲸鱼标（原版 FishLogo.tsx 路径原样拷贝）
└── server.ts  Bun 原生 HTTP 适配层（Bun.serve，无框架、无外部依赖）
```

## 运行

```bash
cd /home/z/my-project/hsl-projects/deepseek-harness
bun web/server.ts
# → http://localhost:5030/
```

- `GET /`           → replica/index.html（及 app.css / app.js / logo.svg）
- `GET /api/health` → `{"ok":true}`
- `POST /api/chat`  → `{"message": "...", "fixture"?: "fix-variance.json"}`

`/api/chat` 流程：复制 `workspace/` 到 `/tmp/dsh-web-ws<rand>`（每次随机、用后即删，
防污染）并把 `stats.ts` 重置为剧本设计的「待修复」初始态 → `bun .toolchain/dhv-ts/src/main.ts
run dsh.hsl --workspace … --task <message> --model scripted --fixture … --out /tmp/dsh-web-run<rand>`
→ 解析 `transcript.jsonl`（模型/工具轮次）+ `report.md`（预算与 verdict）+ `events.jsonl`
（runner 生命周期事件，原样回传为 `runner` 字段）→ 返回：

```jsonc
{
  "ok": true,
  "events": [
    { "type": "tool", "tool": "read_file", "args": { "path": "stats.ts" },
      "input": "{\n  \"path\": \"stats.ts\"\n}", "output": "1 | …", "ok": true },
    { "type": "assistant", "text": "fixed variance to sample formula …" }
  ],
  "report": { "ok": true, "verdict": "accepted", "turns": 5, "tool_calls": 5,
              "bash_calls": 1, "failures": 0, "events_logged": 25, "elapsed_ms": 75 },
  "runner": [ /* events.jsonl 原样 */ ]
}
```

app.js 收到后在 transcript 里按序渲染工具卡（可折叠 IN/OUT 卡）→ assistant 消息
（迷你 markdown：代码块/行内码/加粗/斜体/链接/标题/列表）→ 居中 stats 行。

### 关于 workspace 重置

repro 的 `workspace/stats.ts` 目前处于一次历史验证运行后的「已修复」态（Task 2 端到端
验证时写回过），此时 fixture 的 `edit_file.old_text` 匹配不到。`server.ts` 只在
`/tmp` 临时副本上把它重置回 README 描述的初始态（variance 分母错误 + median 缺失），
保证剧本按原设计走完 5 次工具调用且测试全 PASS；**不改动 repro 目录内任何文件**。

## 与原版 UI 的关系

### 令牌与度量来源（逐字提取）

| 复刻内容 | 原仓库来源 |
|:---|:---|
| 静态色阶 + 别名令牌（明暗两套，`body[data-ds-dark-theme]` 切换） | `packages/client/ui-theme/src/styles/design-platform.css` |
| 字体阶梯（`--dsw-font-*`）、正文轴（`--dsh-content-font-size` 14px 档） | `ui-theme/src/styles/gradient-shadow-text.css` |
| 字体族、代码字体族、缓动曲线 | `ui-theme/src/styles/base.css` |
| 滚动条皮肤（8px WebKit thumb + l1/l2 重绑） | `ui-theme/src/styles/scrollbar.css` |
| 全局 `corner-shape: superellipse(1.5)` | `ui-theme/src/styles/corner-shape.css` |
| boot 页（wordmark/spinner/hint） | `packages/client/web/src/boot-page.module.css` + `boot-page.ts` |
| 三栏框架（280px 侧栏 + 中列，0.5px l3 分界，1024 断点收 rail） | `ui-layout/src/client/AppFrame.module.css` + `columns.ts` |
| 侧栏（logoRow 60px、新会话 38px/r12、会话行 32px、底座） | `ui-sidebar/src/client/SidebarRoot.module.css` + `ui-workspace/rows/Rows.module.css` |
| 会话列（头部 12/28/0/20 + 发丝线、内容宽 clamp(680, 64%, 920)、composer 卡 W+32） | `ui-conversation/src/client/skeleton/ConversationRoot.module.css` |
| composer（卡 r22、elevation-soft、textarea 4/8/0/16、+ 28 圆、select 28/r8、发送 34 圆 info-fill 蓝） | `ui-conversation/src/client/skeleton/InputBar.module.css` |
| 消息流（scroll 16/(16+16)、列宽居中、flow 间距 16） | `ui-chat/src/client/chat/ChatView.module.css` |
| 用户气泡（r22、pad 10/16、bubble 令牌、70.2% 上限） | `ui-chat/src/client/chat/MessageItem.module.css` |
| assistant markdown（14/24、块距 16、行内码 chip、代码块 r12+banner） | `ui-chat/…/AssistantMarkdown.module.css` + `ui-primitives/src/markdown/*` |
| 工具行（24px 行、leading 16+6、标题 13/24 次级、分隔点 2×2、IN/OUT 卡 r12） | `ui-tool/src/client/tool/components/ToolRow.module.css` + `ui-primitives/src/DisclosureRow.module.css` |
| stats 行（13/20 三级色居中） | `ui-chat/src/client/chat/StatsLine.module.css` |
| turn 状态 shimmer（deepseek-500→200 扫过） | `ui-chat/…/ChatView.module.css` `.turnStatus` |
| 鲸鱼标 SVG | `ui-primitives/src/FishLogo.tsx`（路径原样） |

关键令牌摘要（浅 → 深）：

| 用途 | 浅色 | 深色 |
|:---|:---|:---|
| 页面底 `bg-base` | `#FFFFFF` (neutral-bluish-00) | `#151517` (950) |
| 侧栏 `sidebar-fill` | `#F9FAFB` (50) | `#1B1B1C` (900) |
| 主文字 `label-primary` | `#0F1115` (1000) | `#F9FAFB` (50) |
| 次级 / 三级 / caption | `#61666B` / `#81858C` / `#ADB2B8` | `#CFD3D6` / `#979DA6` / `#81858C` |
| 用户气泡 `bubble` | `#EDF3FE` (deepseek-50) | `#2C2C2E` (850) |
| 输入卡 `input-major` | `#FFFFFF` | `#2C2C2E` |
| 代码块 `markdown-code-block` | `#F9FAFB` | `#1B1B1C` |
| 边框 l2 / l3 | `rgba(0,0,0,.10)` / `.12` | `rgba(255,255,255,.12)` / `.16` |
| 品牌蓝 `button-info-fill` | `#4176E6` (deepseek-500) | `#679EFE` (deepseek-400) |
| 成功 / 错误 | `#22C55E` / `#EC1313` | `#22C55E` / `#F25A5A` |
| hover 洗色 | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` |
| 字体 | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', …`（同栈两套） | 同左 |
| 代码字体 | `'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, …` | 同左 |

### 复刻范围

- boot 加载页（wordmark 居中 + 环形 arc spinner + 插件计数 hint，约 0.8s 后进主界面）
- 主界面：侧栏（品牌行 + 新会话 + 会话列表 + 主题切换 + 设置占位 + 署名）/ 主区
  （会话标题头部 + transcript：用户气泡、assistant markdown、可折叠工具调用卡、
  stats 行 / 底部 composer：textarea + 模型 chip + 发送按钮）
- 明暗主题切换（`body[data-ds-dark-theme]`，localStorage 记忆，默认跟随系统）
- 侧栏折叠（280px ↔ 56px rail；≤1023px 自动 rail）
- 空会话 hero 相位（composer 垂直居中，同原版 hero 布局度量）

### 未复刻部分（清单）

- settings 面板 / 权限预设 / 模型管理页（设置按钮置 disabled 占位）
- 附件上传、@ 引用触发菜单、斜杠命令、Plan/Read-only 模式 chip、context meter
- trajectory / details 第三栏（原版三栏 grid 的 details 列固定 0 宽）
- diff/read/search/web 专用工具卡（统一用通用 IN/OUT 卡代替；bash 输出亦走 IN/OUT）
- 虚拟滚动、历史分页、重试/分支 turn 导航、消息反馈、toast、tooltip、模态
- shiki 语法高亮（代码块纯文本）、katex、CJK 自动间距微调保留 `text-autospace`
- 会话持久化（内存态，刷新即重置——任务约定可接受）
- i18n（界面文案取 zh 词典主字符串；原版为 zh/en 双语切换）

## License / 署名

- 视觉与结构设计、设计令牌、鲸鱼标路径：© deepseek-ai，MIT
  （<https://github.com/deepseek-ai/deepseek-harness>）
- 本目录（replica/ + server.ts）：HSL 复现项目的适配产物，MIT
