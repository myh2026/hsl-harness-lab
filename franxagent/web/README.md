# FranxAgent 原版 UI × HSL 复现后端 — Web 适配服务器

> Bun 原生 HTTP 服务器（`Bun.serve`，无框架、无 npm 依赖，仅 `node:crypto` /
> `node:fs` / `node:path`），把 **原版 FranxAgent 前端**（AGPL-3.0，逐字拷贝、
> 一字节未改）接到 **HSL 复现后端**（`franxagent.hsl` + dhv-ts 解释器）上。

## 运行

```bash
cd /home/z/my-project/hsl-projects/franxagent
bun web/server.ts          # 监听 http://localhost:5010
```

打开 <http://localhost:5010/register> 首次设置密码（原版把「注册」实现为
首跑设置口令），随后进入 `/` 聊天页。默认剧本为 `fixtures/fix-notes.json`
的交互式变体：read → **write 提案 → Code Review Panel（diff/可编辑）→
批准 → 落盘** → command 删除拦截 → 终答。

## UI 版权声明（重要）

`web/templates/`（3 个 html）、`web/static/`（js/css）、`web/i18n/{zh,en}.yaml`
是上游 [FranxAgent](https://github.com/xhdlphzr/FranxAgent)
（© 2026 xhdlphzr，**AGPL-3.0**，全文见 `web/UI_LICENSE.AGPL`）的**逐字拷贝**，
已用 `diff -r` / 逐文件 `cmp` 验证字节一致，**本任务未改动其中任何一字节**
（模板内无 Jinja 占位符 / `url_for`，纯静态输出 + 运行时 i18n，故适配层可
原样供给）。本适配服务器（`server.ts`）本身按 MIT 发布。

## 请求 → HSL 运行的映射（/chat 的实现原理）

`POST /chat` 收到消息后：

1. 复制 `workspace/` → `/tmp/franx-web-ws-<随机>`（源工作区永不触碰；另留
   `-pristine` 运行前快照，供工具回放取「模型当时看到的」内容）；
2. 生成**本次运行的剧本副本**（默认取 `fixtures/fix-notes.json` 的 acts，
   approvals 轨道替换为 `reject: deferred to Code Review Panel (web UI)`）；
3. 子进程运行 dhv-ts：
   `bun .toolchain/dhv-ts/src/main.ts run franxagent.hsl --workspace <副本>
   --task <任务> --model scripted --fixture <剧本副本> --out <产物目录>`；
4. 解析 `report.md`（终答 + turns/tool_calls/proposals/corrections… 统计），
   并按剧本 acts（经 router.hsl 同款「纠偏」解析）回放为原版 SSE 事件流：
   `content` / `tool_call` / `tool_result` / `write_proposal`（阻塞等待
   `/api/confirm_tool`，期间 5s 一条 SSE 注释行保活）/ `html` / `done`；
5. write 提案的「应用后全文」用与 `tools/fs.hsl`（及原版 write tool）完全
   相同的三模式算法计算，并已与 stock 剧本运行的实际落盘产物逐字节比对一致。

**scripted 解耦披露**：解释器 `--task` 传剧本所需文案（`fix-notes` 场景为
「请更新 notes.txt 第 2 行，把 TODO 标记为 DONE」，即 README 运行方式中
的固定任务），与用户聊天消息解耦；响应末尾以引用块如实注明（任务文案 +
真实运行统计）。用户输入与剧本文案一致时不加解耦说明。

**选剧本**：请求头 `x-hsl-fixture` 或 body 字段 `fixture`：
- 空 / `fix-notes-defer`（默认）：交互式提案（推荐，完整人机链路）；
- `fix-notes`：仓内剧本原样（approvals=`["approve"]`，HSL 闸门**在运行中
  自动批准并落盘**；此时面板打开时 `/api/read_file` 读到的是已写入状态，
  diff 为空——如实反映「已发生」而非伪造差异）；
- 其它路径（相对项目根或绝对）：自定义 fixture；带 approvals 轨道按原样
  （stock 行为），否则延迟到 UI；`--task` 用用户消息本身。

## 端点清单（对照原版 src/routes/*）

### 逐条实现（语义对齐）

| 端点 | 方法 | 原版位置 | 状态 |
|:---|:---|:---|:---|
| `/login` `/register` `/` | GET | app.py | ✅ 模板原样（无 Jinja 注入需求） |
| `/static/*` | GET | app.py | ✅ web/static 原样 |
| `/api/public-key` | GET | auth.py | ✅ P-256 SPKI PEM（ECIES 契约同形） |
| `/api/setup` | POST | auth.py | ✅ ECIES 解密→存哈希→发 JWT（首跑设置口令；已设则 400） |
| `/api/login` | POST | auth.py | ✅ 校验→JWT；401/400 错误形状同原版 |
| `/api/check-auth` | GET | auth.py | ✅ `{password_set, authenticated}` |
| `/api/i18n` | GET | auth.py | ✅ 最小 YAML 子集解析器（嵌套 map+引号串+`\n` 转义），按 config.language 选 zh/en |
| `/session` | GET | app.py | ✅ `{startup_id}`（启动时间秒） |
| `/chat` | POST | chat.py | ✅ SSE 全事件协议（见上），含 write_proposal 阻塞等待 + 客户端断开清理 |
| `/api/confirm_tool` | POST | chat.py | ✅ `{confirm_id, approved, final_content}`；批准→写运行副本工作区（幂等，UI 先经 /api/write_file 写入，与原版一致）；未知 id 404 |
| `/api/read_file` | POST | chat.py | ✅ `{path}` → `{content}`；指向最近一次运行副本（无运行时回退源工作区）；不存在→空串 |
| `/api/write_file` | POST | chat.py | ✅ 写运行副本；`{status:"ok"}` |
| `/api/messages` | GET | config.py | ✅ OpenAI 形状会话历史（user / assistant+tool_calls / tool），app.js 合并渲染 |
| `/api/save_partial` | POST | config.py | ✅ 中止时补一条 assistant 消息 |
| `/config` | GET/POST | config.py | ✅ web/.data/config.json 持久化；POST 校验 api_key/base_url/model 必填；language 切换即时影响 /api/i18n |
| `/tasks` | GET/POST | tasks.py | ✅ add/delete 存取 web/.data/tasks.json（无调度执行） |

### 简化兼容（有据可查的偏差）

| 端点 | 偏差与理由 |
|:---|:---|
| `/events`（SSE） | 原版带 `login_required`，但 `EventSource` **无法携带 Bearer 头**（原版设密码后会 401 循环重连、控制台持续网络错误）。适配层放宽为**开放式心跳流**（`: heartbeat`，10s）。无调度器，永不发 task_* 事件。 |
| `/cancel_task/<id>` | 无后台调度器（MCP/定时任务不在 HSL 复现范围）→ 恒 404 `{"error":"Task does not exist or has already ended"}`（原版对不存在任务同为 404）。 |
| knowledge SSE 事件 | HSL 混合检索在解释器内部完成、不落 artifacts → 不伪造，跳过（协议允许 0 项；chat.js 处理正常）。 |
| `confirmation_required`（command 确认块） | 不发：HSL 复现的 command 语义是**删除动词黑名单硬拦截**（比原版「弹确认框等用户」更严），rm 在工具层直接拒绝并给出移回收站指引——事件流如实回放该拒绝结果。 |
| `/api/read_file` 绝对路径 | 原版允许任意绝对路径（`expanduser().resolve()`）；适配层限制在运行副本工作区内（防越界读取，403 `Path escapes run workspace`）。 |
| 自定义剧本的 search 等网络型工具结果 | 解释器已执行但结果不落 artifacts → tool_result 如实标注 `(executed inside scripted HSL run; output not captured)`。 |

## 认证实现说明

- 前后端**密码传输契约与原版逐位一致**：前端（原版 login.js/register.js 的
  WebCrypto 代码，未改）做 ECDH-P256 → HKDF-SHA256(salt=∅,
  info=`"franxagent-ecc-encryption"`, 32B) → AES-256-GCM(12B IV) 的 ECIES，
  POST `{ephemeral_key(b64 SPKI DER), iv, ciphertext}`；服务端用 node:crypto
  `diffieHellman` + `hkdfSync` + `createDecipheriv('aes-256-gcm')` 解密，
  与原版 `src/auth.py ecc_decrypt` 同参数同语义（真实浏览器已验证互通）。
- 服务器密钥对：P-256，PEM 存 `web/.data/ec-{public,private}.pem`（重启保持）。
- **密码哈希**：原版 bcrypt → 适配层 `scrypt`（node:crypto 内建，无依赖；
  盐 16B、键 64B、`timingSafeEqual` 比较）。**偏差披露**：算法不同，强度等价。
- **JWT**：HS256，payload `{exp: now+1h, iat: now}`，secret 随机落
  `web/.data/auth.json`——与原版 `generate_jwt_token` 同构。
- `login_required` 语义保留：未设置密码时放行（原版首跑前所有接口开放），
  设置后校验 `Authorization: Bearer <jwt>`，失败 401 `{"error":"Unauthorized"}`。
- 单口令模型（同原版：注册=首跑设置口令，无多用户注册表）；会话状态
  （历史/挂起提案）为内存态，重启即新会话（`/session` startup_id 变化触发
  前端清空本地聊天，与原版行为一致）。

## 运行时数据

- `web/.data/`：auth.json / config.json / tasks.json / EC 密钥（首次运行自动生成，可删）。
- `/tmp/franx-web-ws-*`（运行副本工作区）、`/tmp/franx-web-run-*`（解释器产物）：
  每次聊天新建，>1h 的旧目录自动清扫；**项目内 `workspace/` 永不被写**。

## 已知限制（诚实披露）

- scripted（剧本）模型是确定性的：用户消息只决定 UI 展示与 `/api/messages`
  记录，解释器任务文案按剧本解耦（见上文披露，响应中注明）。
- CodeMirror 的 `toTextArea()` 在 CDN 5.65.16 上已移除——原版 chat.js 的
  destroy() 自带 try/catch 兜底并 console.warn（浏览器控制台会出现一条
  warning，面板正常关闭；此为原版未改代码 + 该 CDN 版本的固有行为，非适配层缺陷）。
- 模板引用的 CDN 资源（marked / highlight.js / CodeMirror / KaTeX / mermaid）
  需要外网可达（与运行原版 FranxAgent 的要求相同）。
