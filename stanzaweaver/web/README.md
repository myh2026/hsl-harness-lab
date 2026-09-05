# StanzaWeaver Web 适配层（原版 UI ↔ HSL 复现流水线）

把 [StanzaWeaver](https://github.com/xhdlphzr/StanzaWeaver) **原版前端逐字拷贝**
（`templates/index.html` + `static/style.css` + `i18n/{zh,en}.yaml`，MIT，
见 `UI_LICENSE.MIT`，与上游 `LICENSE` 逐字节一致）接到 HSL 复现的
四步流水线（`../stanzaweaver.hsl`，dhv-ts 解释器以 scripted 剧本驱动）上，
零改动原版 UI 的任何一个字节。

## 运行

```bash
cd hsl-projects/stanzaweaver/web
bun install            # 仅一个运行依赖：socket.io（devDep: socket.io-client，仅测试用）
cd ..
bun web/server.ts      # 监听 127.0.0.1:5020
```

打开 <http://localhost:5020>（Chromium 若优先解析 `localhost` 为 `::1`，
请直接用 `http://127.0.0.1:5020`）。

- 节拍：事件推送间隔默认 320ms/拍；`STANZA_WEB_PACING=fast bun web/server.ts`
  供自动化测试加速。
- 全链路测试：`cd web && node tools/test-client.mjs`（31 项断言：
  generate / feedback / 错误路径）。

## 原理

```
原版 index.html（CDN: socket.io 4.7.5 client + CodeMirror 5.65 + Google Fonts）
      │  REST /api/*（与原版 app.py 契约同形）     │  Socket.IO（generate/feedback）
      ▼                                            ▼
web/server.ts（bun + node:http + socket.io 4.8，端口 5020）
      │                                            │
      │  i18n/*.yaml → 最小 YAML 子集解析           │  剧本回放 + 符号层复刻 → progress/done
      ▼                                            ▼
dhv-ts 解释器：bun ../.toolchain/dhv-ts/src/main.ts run ../stanzaweaver.hsl
  --task <用户主题> --model scripted --fixture ../fixtures/weave-moon.json
  → run.json / events.jsonl / report.md（终稿与回放交叉校验的 ground truth）
```

- **socket.io 客户端来源**：原版 index.html 从
  `https://cdn.socket.io/4.7.5/socket.io.min.js` 加载客户端（逐字保留），
  服务端用 socket.io **4.8.x**（engine.io v4 协议，与 4.7.5 客户端双向兼容）。
  服务端同时在默认路径 `/socket.io/socket.io.js` 提供自带客户端（未用到）。
- **承载方式**：socket.io 需要挂接 Node HTTP server 事件接口，无法挂
  `Bun.serve` 的 fetch 模型，故用 `node:http`（Bun 原生实现）承载，进程仍由
  `bun` 运行——这是对「Bun.serve + attach」字面要求的唯一可行偏离。

## REST 端点（复刻原版 app.py 契约）

| 端点 | 方法 | 行为（与原版差异） |
|:---|:---|:---|
| `/` | GET | 渲染 `templates/index.html`，注入 `{{ csrf_token }}`（随机 hex，每进程一枚） |
| `/static/*` | GET | 服务 `static/` 目录（原版 Flask static） |
| `/api/i18n/<lang>` | GET | `i18n/*.yaml` → 原版形状 JSON。**最小 YAML 子集解析器**（嵌套 map + 字符串标量，即这两个文件的全部语法）；与 `yaml.safe_load` 输出逐键一致（已比对） |
| `/api/templates` | GET | 模板列表，形状同原版 `list_dicts()`：`{key,name,language,lines,syllables_per_line,syllable_constraints,display_name}`。数据提炼自 HSL 复现 `prosody/templates.hsl`：`zh-wujue / zh-qijue / en-couplet`（注意原版 key 用下划线，HSL 复现注册表用连字符）+ 内存态自定义模板 |
| `/api/templates/meta` | GET | 同原版 `custom_template_schemes()` + 各语言 `_check_*` helpers（zh 8 个 / en 2 个 / it 3 个 / fr 1 个 / la 0 个，与原版源码一致） |
| `/api/config` | GET/POST | GET 需 CSRF；POST 需 CSRF，内存态保存 writer/checker/language。简化：scripted 模式保存后 llm 状态恒回 `ok`（原版重 ping 真实端点）；默认 language=zh |
| `/api/history` | GET/POST | POST 需 CSRF；**内存态**（原版 SQLite `~/.stanza_weaver/history.db`），最近 50 条，字段/created_at 格式同形 |
| `/api/import-status` | GET | 恒 `{importing:false}`（HSL 词汇表为 lexicon.hsl 内置种子，无导入阶段；原版后台线程导词库） |
| `/api/llm-status` | GET | 恒 `{writer:"ok",checker:"ok"}`（scripted 模型恒可用——前端生成按钮因此可用） |
| `/api/llm-ping` | POST | 需 CSRF；返回 ok/ok 并广播 `llm_status` |
| `/api/templates/custom` | POST | 需 CSRF；校验同原版（名称/语言/行数/音节数），**内存注册**（原版落盘 `custom_*.py` 并热注册）；成功后广播 `templates_updated` |
| （全局） | — | Host 头本地校验（仅 `127.0.0.1`/`localhost` 前缀，非本机 403——同原版 `_guard_local_access`）；写接口一律 X-CSRF-Token 校验 |

## Socket.IO 事件

**服务端 → 客户端**（载荷形状与原版逐字段对齐）：

| 事件 | 载荷 | 说明 |
|:---|:---|:---|
| `llm_status` | `{writer,checker}` | 连接建立即推 + llm-ping/保存配置后广播（原版为后台线程周期推送） |
| `progress` | 见下 | 流水线每拍进度（原版 `_report` 13 字段全量快照） |
| `done` | `{draft, final_poem, title, formatted_poem, checker_pass, checker_suggestions, step_details}` | 原版 `_emit_done` 载荷 |
| `error` | `{message}` | 原版错误事件 |
| `templates_updated` | `{count}` | 自定义模板注册后广播 |

**客户端 → 服务端**：`generate {topic, template_key}`、`feedback {feedback}`。
多会话隔离：全部事件 `io.to(socket.id).emit(...)`（等价原版 `to=session_id`），
`_activeStates` 按 socket.id 存会话状态，disconnect 清理。

## progress 事件映射（HSL 事件 → 原版形状）

`progress` 载荷 13 字段全量快照（每次都带完整 `step_details`，前端按 `seq` 去重）：
`step`(1-4) / `description` / `draft` / `title` / `refine_rounds` / `checker_pass` /
`checker_suggestions` / `step_details[{step,title,content,rounds?,seq}]` / `last_tool` /
`last_tool_result` / `stream_text` / `current_detail_step` / `current_detail`。

生成流程 = **并行执行**：(a) 真实 dhv-ts scripted 运行（`--task` 取用户主题，
HSL 入口 `main()` 硬编码 `zh-wujue` + weave-moon 剧本）；(b) 剧本回放推送。
回放的数据源与规则全部与 HSL 复现同源：

| 流水线步 | 映射来源 |
|:---|:---|
| Step 1 描述（流式） | 剧本 `writer[0]` 按标点切片流式推送（模拟原版 0.25s 节流）；终稿入 `step_details` |
| Step 2 初稿（流式+行渲染） | 剧本 `writer[1]` → 诗行；终稿入 `step_details` |
| Step 3 炼句循环 | 逐条解析剧本 `writer[2..]` 工具调用 JSON：每轮先推 `_thinking` 流式片段（原版 on_stream 形状），再执行**符号层复刻**判定受理/拒绝 |
| Step 4 终审 | 剧本 `checker[0]` verdict × `report.md` 统计交叉校验；`step_details` 附 events.jsonl 事件轨迹 |
| done | `report.md` 的标题/诗行/checker_pass 为准（回放终稿与运行产物一致才无告警）；`formatted_poem` 按原版模板类规则（绝句一句一行加句号） |

**符号层复刻**：服务端启动时解析 `prosody/lexicon.hsl` 的 30 条种子词条
（`word/tone/rhyme/meaning` 正则提取），并在 TS 侧逐条复刻
`prosody/validator.hsl` 的判定与**报错文案**（逐字平仄/韵脚/三平尾/孤平/
行数/字数，含 HSL 实现「孤平检查恒启用」的行为）以及
`tools/weave.hsl` 四工具的 observation 文案——因此剧本中那次
`refine_line("月江烟寒对")` 被**符号层拒绝**（`第 3 行第 1 字 "月" 应平实仄`）
的场景在 progress 事件流里与 HSL 运行行为一致。终稿与 `report.md` 逐行
交叉校验（不一致以运行产物为准并告警）。

`feedback`：打回 Step 3 重入（对齐原版 `continue_with_feedback`），
重跑 dhv-ts + 剧本，`step_details.seq` 续接，Step 3 详情首行注明
「用户反馈已注入 writer 上下文」。

## 已知简化（诚实披露）

1. **scripted 固定剧本**：`weave-moon` 剧本产物固定（月夜主题五绝），
   用户主题仅作为 `--task` 传入（ScriptedPoet 不读提示词，主题/模板选择
   与产物**解耦**）；HSL 入口硬编码 `zh-wujue`——选其它模板时 Step 2 详情
   会注明「剧本绑定 zh-wujue，所选模板仅作展示」。接真实 LLM 需改 HSL 侧
   （`--model deepseek`）。
2. **progress 回放**：events.jsonl 只含 `run_start`/node×4/`run_end`
   （dhv-ts 的事件粒度在 node 初始化级），步级/工具级进度由剧本+符号层
   复刻推导（数据同源，终稿以运行产物校验）——即回放忠实但非逐事件直译。
3. 自定义模板/历史/配置为**内存态**（重启即失）；自定义模板不能被 HSL
   流水线真正执行（生成仍走 zh-wujue 剧本）。
4. `formatted_poem` 的句号排版在适配层实现（原版在 Python 模板类
   `format_poem`，HSL 复现无此层）。
5. 词库无导入阶段、LLM 状态恒 ok（见上表）；llm_status 改为连接即推
   （原版为后台线程周期推送）。

## 版权

- `templates/index.html`、`static/style.css`、`i18n/*.yaml`：
  [StanzaWeaver](https://github.com/xhdlphzr/StanzaWeaver)（xhdlphzr，MIT）
  逐字拷贝，`cmp` 校验与上游一致；许可文本见 `UI_LICENSE.MIT`。
- `server.ts` / `tools/test-client.mjs`：本复现项目（MIT，同上游）。
