// ============================================================================
// franxagent/web/server.ts — Bun HTTP 适配服务器
// ============================================================================
// 让原版 FranxAgent UI（web/templates + web/static，逐字拷贝、一字节未改）
// 原样跑在 HSL 复现后端（dhv-ts 解释器 + franxagent.hsl）之上。
//
// - 无框架：Bun.serve 原生路由
// - 依赖仅 node:crypto / node:fs / node:path（无 npm 依赖）
// - 端口 5010
//
// 前后端契约来源（逐行细读原仓库 /tmp/hsl_repos/FranxAgent）：
//   src/routes/auth.py    /api/public-key /api/setup /api/login
//                         /api/check-auth /api/i18n
//   src/routes/chat.py    /chat (SSE) /api/confirm_tool /api/read_file /api/write_file
//   src/routes/config.py  /config /api/messages /api/save_partial
//   src/routes/tasks.py   /tasks /events /cancel_task/<id>
//   src/app.py            /login /register / /session
//
// UI 文件版权：FranxAgent（github.com/xhdlphzr/FranxAgent），AGPL-3.0，
// 见 web/UI_LICENSE.AGPL。本适配层为 MIT。
// ============================================================================

import {
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------

const PORT = 5010;
const WEB_DIR = path.dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = path.dirname(WEB_DIR); // .../hsl-projects/franxagent
const TOOLCHAIN_MAIN = path.resolve(PROJECT_ROOT, "..", ".toolchain", "dhv-ts", "src", "main.ts");
const ENTRY_HSL = path.join(PROJECT_ROOT, "franxagent.hsl");
const WS_SOURCE = path.join(PROJECT_ROOT, "workspace"); // 演示工作区（只读源，运行时拷贝）
const DEFAULT_FIXTURE = path.join(PROJECT_ROOT, "fixtures", "fix-notes.json");
const DATA_DIR = path.join(WEB_DIR, ".data");
const TMP_BASE = "/tmp";

// fix-notes.json 剧本对应的规范任务文案（README 运行方式中固定的 --task）。
// scripted 模式下解释器 --task 与用户聊天消息解耦：传剧本需要的文案，
// 响应中如实注明（见 streamFootnote）。
const CANONICAL_TASK = "请更新 notes.txt 第 2 行，把 TODO 标记为 DONE";

// 与原版 tools/command.py / HSL tools/command.hsl 一致的删除动词黑名单
const DELETE_VERBS = ["rm", "del", "rmdir", "shred"];
// HSL FRANX_CONFIG.max_output_chars（工具输出封顶）
const MAX_OUTPUT_CHARS = 4000;
// write 提案等待用户批准的最长时间（超时视为拒绝，防僵尸流）
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
// SSE 等待期间的保活间隔（防空闲超时；chat.js 忽略非 data: 行）
const KEEPALIVE_MS = 5_000;

// ---------------------------------------------------------------------------
// 持久化状态（web/.data）
// ---------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function saveJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

interface AuthState {
  password?: { salt: string; hash: string }; // scrypt（node:crypto；原版 bcrypt）
  jwt_secret?: string;
}
const authFile = path.join(DATA_DIR, "auth.json");
const auth: AuthState = loadJson<AuthState>(authFile, {});
function persistAuth(): void {
  saveJson(authFile, auth);
}

const configFile = path.join(DATA_DIR, "config.json");
let config: Record<string, unknown> = loadJson<Record<string, unknown>>(configFile, {
  language: "en",
  api_key: "",
  base_url: "",
  model: "scripted",
  settings: "You are a helpful AI assistant.",
  temperature: 0.8,
  thinking: false,
  knowledge_k: 5,
  tools: { ett: {} },
  mcp_servers: [],
});

const tasksFile = path.join(DATA_DIR, "tasks.json");
let tasks: Record<string, string> = loadJson<Record<string, string>>(tasksFile, {});

const STARTUP_ID = String(Math.floor(Date.now() / 1000)); // 原版 /session 语义

// 会话历史（OpenAI 形状，镜像原版 state.chat_agent.messages）
interface HistoryToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface HistoryMessage {
  role: string;
  content?: string;
  tool_calls?: HistoryToolCall[];
  tool_call_id?: string;
  knowledge?: string[];
}
const history: HistoryMessage[] = [];

// ---------------------------------------------------------------------------
// ECIES（ECDH P-256 + HKDF-SHA256 + AES-256-GCM）—— 原版 src/auth.py 协议
// 前端 login.js/register.js 用 Web Crypto 以相同参数加密。
// ---------------------------------------------------------------------------

const HKDF_INFO = "franxagent-ecc-encryption";

let PRIVATE_KEY_PEM = "";
let PUBLIC_KEY_PEM = "";
{
  const privFile = path.join(DATA_DIR, "ec-private.pem");
  const pubFile = path.join(DATA_DIR, "ec-public.pem");
  if (fs.existsSync(privFile) && fs.existsSync(pubFile)) {
    PRIVATE_KEY_PEM = fs.readFileSync(privFile, "utf8");
    PUBLIC_KEY_PEM = fs.readFileSync(pubFile, "utf8");
  } else {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;
    fs.writeFileSync(privFile, PRIVATE_KEY_PEM, { mode: 0o600 });
    fs.writeFileSync(pubFile, PUBLIC_KEY_PEM);
  }
}
const PRIVATE_KEY = createPrivateKey(PRIVATE_KEY_PEM);

interface EciesPayload {
  ephemeral_key: string; // base64 SPKI DER
  iv: string; // base64 12B nonce
  ciphertext: string; // base64（含 16B GCM tag）
}

function eciesDecrypt(payload: EciesPayload): string {
  const ephPub = createPublicKey({
    key: Buffer.from(payload.ephemeral_key, "base64"),
    format: "der",
    type: "spki",
  });
  // WebCrypto deriveBits(ECDH, 256) == x 坐标 32 字节，node diffieHellman 同
  const shared = diffieHellman({ privateKey: PRIVATE_KEY, publicKey: ephPub });
  const aesKey = hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(HKDF_INFO), 32);
  const iv = Buffer.from(payload.iv, "base64");
  const ct = Buffer.from(payload.ciphertext, "base64");
  const tag = ct.subarray(ct.length - 16);
  const body = ct.subarray(0, ct.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(aesKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// JWT HS256（原版 exp=1h）+ 密码（scrypt 替代 bcrypt：无依赖）
// ---------------------------------------------------------------------------

function b64url(b: Buffer): string {
  return b.toString("base64url");
}

function signJwt(): string {
  if (!auth.jwt_secret) {
    auth.jwt_secret = randomBytes(32).toString("base64url");
    persistAuth();
  }
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ exp: now + 3600, iat: now })));
  const sig = b64url(createHmac("sha256", auth.jwt_secret).update(`${head}.${payload}`).digest());
  return `${head}.${payload}.${sig}`;
}

function verifyJwt(token: string): boolean {
  if (!auth.jwt_secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const expected = b64url(
    createHmac("sha256", auth.jwt_secret).update(`${parts[0]}.${parts[1]}`).digest(),
  );
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && payload.exp >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function hashPassword(pw: string): { salt: string; hash: string } {
  const salt = randomBytes(16);
  return { salt: salt.toString("hex"), hash: scryptSync(pw, salt, 64).toString("hex") };
}
function checkPassword(pw: string): boolean {
  if (!auth.password) return false;
  const h = scryptSync(pw, Buffer.from(auth.password.salt, "hex"), 64);
  return timingSafeEqual(h, Buffer.from(auth.password.hash, "hex"));
}

/** 原版 login_required 语义：未设密码时放行；否则校验 Bearer。 */
function requireAuth(req: Request): boolean {
  if (!auth.password) return true;
  const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
  return !!token && verifyJwt(token);
}

// ---------------------------------------------------------------------------
// 最小 YAML 子集解析器（嵌套 map + 字符串；web/i18n/{zh,en}.yaml 够用）
// ---------------------------------------------------------------------------

function parseYamlScalar(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function parseYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [
    { indent: -1, obj: root },
  ];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (value === "") {
      const obj: Record<string, unknown> = {};
      parent[key] = obj;
      stack.push({ indent, obj });
    } else {
      parent[key] = parseYamlScalar(value);
    }
  }
  return root;
}

const i18nCache = new Map<string, { mtime: number; data: Record<string, unknown> }>();
function loadI18n(lang: string): { language: string; translations: Record<string, unknown> } {
  const dir = path.join(WEB_DIR, "i18n");
  let file = path.join(dir, `${lang}.yaml`);
  if (!fs.existsSync(file)) file = path.join(dir, "en.yaml");
  if (!fs.existsSync(file)) return { language: lang, translations: {} };
  const mtime = fs.statSync(file).mtimeMs;
  const hit = i18nCache.get(file);
  if (hit && hit.mtime === mtime) return { language: lang, translations: hit.data };
  const data = parseYaml(fs.readFileSync(file, "utf8"));
  i18nCache.set(file, { mtime, data });
  return { language: lang, translations: data };
}

// ---------------------------------------------------------------------------
// HSL 侧工具语义复刻（与 tools/fs.hsl / tools/command.hsl 逐字对齐）
// ---------------------------------------------------------------------------

/** fs.hsl number_lines：`i | line`，每行换行；lines() 丢弃末尾空段。 */
function numberLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l, i) => `${i + 1} | ${l}\n`).join("");
}

function capChars(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

/** 原版 write tool（knowledge/tools/write/tool.py）与 HSL apply_write_mode 一致的三模式计算。 */
function applyWriteMode(
  before: string,
  content: string,
  mode: string,
  startLine: number,
  endLine: number,
): string {
  if (mode === "overwrite") return content;
  if (mode === "insert") {
    if (startLine <= 0) {
      if (before && !before.endsWith("\n")) return before + "\n" + content;
      return before + content;
    }
    const lines = before.split("\n");
    if (lines.length === 1 && lines[0] === "") return content;
    const idx = Math.min(startLine, lines.length);
    return [...lines.slice(0, idx), ...content.split("\n"), ...lines.slice(idx)].join("\n");
  }
  // edit：替换 [start_line, end_line]（1 起算，闭区间）
  if (!before) return content;
  const lines = before.split("\n");
  const total = lines.length;
  const start = Math.max(1, startLine);
  const end = endLine > 0 ? Math.min(endLine, total) : total;
  if (start > total) return before + "\n" + content;
  return [...lines.slice(0, start - 1), ...content.split("\n"), ...lines.slice(end)].join("\n");
}

/** command.hsl 删除禁令文案（逐字）。 */
function commandBlockedMessage(firstWord: string): string {
  return `安全策略拒绝：\"${firstWord}\" 是删除命令。请改用移动到安全目录（例如: mv <path> ./to-delete/），并用 write 工具记录移动清单以便用户恢复。`;
}

// ---------------------------------------------------------------------------
// dhv-ts 解释器运行（子进程）
// ---------------------------------------------------------------------------

interface HslRunResult {
  ok: boolean;
  exitCode: number;
  reportMd: string;
  reply: string;
  stats: Record<string, string>;
  stderr: string;
}

function parseReport(md: string): { reply: string; stats: Record<string, string> } {
  const reply = /## 回复\n\n([\s\S]*?)\n\n## 预算与统计/.exec(md)?.[1] ?? "";
  const stats: Record<string, string> = {};
  for (const m of md.matchAll(/^- ([a-z_ ]+): (.+)$/gm)) stats[m[1].trim()] = m[2].trim();
  return { reply, stats };
}

async function runHsl(
  wsDir: string,
  outDir: string,
  fixturePath: string,
  task: string,
): Promise<HslRunResult> {
  const proc = Bun.spawn(
    [
      process.execPath,
      TOOLCHAIN_MAIN,
      "run",
      ENTRY_HSL,
      "--workspace",
      wsDir,
      "--task",
      task,
      "--model",
      "scripted",
      "--fixture",
      fixturePath,
      "--out",
      outDir,
      "--quiet",
    ],
    { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => proc.kill(), 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  void stdout;
  const reportMd = fs.existsSync(path.join(outDir, "report.md"))
    ? fs.readFileSync(path.join(outDir, "report.md"), "utf8")
    : "";
  const { reply, stats } = parseReport(reportMd);
  return { ok: exitCode === 0, exitCode, reportMd, reply, stats, stderr };
}

// ---------------------------------------------------------------------------
// 剧本（fixture）acts 解析 —— 镜像 agents/router.hsl parse_reply 的纠偏逻辑
// ---------------------------------------------------------------------------

interface ParsedCall {
  id: string;
  toolName: string; // 内层实际工具名（read/write/command/...）
  wrapper: Record<string, unknown>; // {tool_name, arguments}（事件里 arguments 用包装形，UI 会解包）
  inner: Record<string, unknown>;
  corrected: boolean;
}
interface ParsedAct {
  text: string;
  calls: ParsedCall[];
}

function parseAct(raw: string): ParsedAct {
  try {
    const obj = JSON.parse(raw) as {
      content?: string;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    if (obj && typeof obj === "object" && Array.isArray(obj.tool_calls)) {
      const calls: ParsedCall[] = obj.tool_calls.map((tc) => {
        const fn = tc.function || {};
        let name = String(fn.name || "");
        let inner: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(String(fn.arguments || "{}"));
          if (parsed && typeof parsed === "object") inner = parsed as Record<string, unknown>;
        } catch {
          inner = {};
        }
        let corrected = false;
        let wrapper: Record<string, unknown>;
        if (name !== "tools" && !name.includes("/")) {
          // 纠偏：直接调用内建工具名 → 包装为 tools 协议（router.hsl 同款）
          corrected = true;
          wrapper = { tool_name: name, arguments: inner };
        } else {
          wrapper = inner;
          name = String((inner as { tool_name?: unknown }).tool_name ?? "");
        }
        return {
          id: String(tc.id || `call_${Math.random().toString(36).slice(2, 8)}`),
          toolName: name,
          wrapper,
          inner:
            (wrapper.arguments as Record<string, unknown>) ??
            ({} as Record<string, unknown>),
          corrected,
        };
      });
      return { text: String(obj.content ?? ""), calls };
    }
  } catch {
    /* 纯文本回复 */
  }
  return { text: raw, calls: [] };
}

// ---------------------------------------------------------------------------
// 运行副本工作区管理 + 提案确认队列
// ---------------------------------------------------------------------------

interface RunWorkspace {
  id: string;
  wsDir: string; // 运行副本（HSL 实际作用的工作区；read_file/write_file 目标）
  pristineDir: string; // 运行前快照（read 工具回放 + 提案 before 的取材——模型当时看到的）
  outDir: string;
}

let lastWorkspace: RunWorkspace | null = null;

function newRunWorkspace(): RunWorkspace {
  const id = randomBytes(6).toString("hex");
  const wsDir = `${TMP_BASE}/franx-web-ws-${id}`;
  const pristineDir = `${TMP_BASE}/franx-web-ws-${id}-pristine`;
  const outDir = `${TMP_BASE}/franx-web-run-${id}`;
  fs.cpSync(WS_SOURCE, wsDir, { recursive: true });
  fs.cpSync(WS_SOURCE, pristineDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  sweepOldRuns();
  return { id, wsDir, pristineDir, outDir };
}

function sweepOldRuns(): void {
  // 尽力清理 1 小时前的 /tmp/franx-web-*（源 workspace 永不触碰）
  try {
    const cutoff = Date.now() - 60 * 60_000;
    for (const name of fs.readdirSync(TMP_BASE)) {
      if (!name.startsWith("franx-web-")) continue;
      const p = path.join(TMP_BASE, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* 并发删除等，忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

/** 路径解析：相对路径锚定运行副本工作区；拒绝越界（原版允许绝对路径——安全简化，见 README）。 */
function resolveInWs(wsDir: string, userPath: string): string | null {
  if (!userPath) return null;
  if (path.isAbsolute(userPath)) return null;
  const resolved = path.resolve(wsDir, userPath);
  if (resolved !== wsDir && !resolved.startsWith(wsDir + path.sep)) return null;
  return resolved;
}

interface PendingConfirm {
  run: RunWorkspace;
  isWrite: boolean;
  proposal?: { path: string; after: string };
  resolve: (decision: { approved: boolean; finalContent?: string; reason?: string }) => void;
  promise: Promise<{ approved: boolean; finalContent?: string; reason?: string }>;
}
const pendingConfirms = new Map<string, PendingConfirm>();

// ---------------------------------------------------------------------------
// /chat SSE 流（原版 chat.py generate() 的兼容实现）
// ---------------------------------------------------------------------------

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface ChatPlan {
  acts: string[]; // 剧本 acts（原始 JSON 字符串）
  stock: boolean; // true=剧本自带 approvals（服务端自动批）；false=延迟到 UI
  hslTask: string; // 解释器 --task（scripted 解耦文案）
  userMessage: string;
  run: HslRunResult;
  ws: RunWorkspace;
}

/** 追加的透明脚注：如实反映 scripted 解耦与 HSL 运行统计。 */
function streamFootnote(plan: ChatPlan): string {
  const s = plan.run.stats;
  const get = (k: string) => s[k] ?? s[`protocol ${k}`] ?? "";
  const parts: string[] = [];
  for (const key of ["turns", "tool_calls", "proposals", "corrections", "failures", "memories"]) {
    if (get(key)) parts.push(`${key} ${get(key).split(" ")[0]}`);
  }
  const note =
    plan.hslTask === plan.userMessage
      ? `dhv-ts scripted 运行统计：${parts.join(" · ")}`
      : `dhv-ts scripted 以剧本任务「${plan.hslTask}」运行（与本次输入解耦）。统计：${parts.join(" · ")}`;
  return `\n\n> ℹ️ **HSL 后端**：${note}`;
}

function minimalMarkdown(text: string): string {
  // 原 /chat 在结束时发 {type:'html'}（markdown 渲染结果）。chat.js 只把它当
  // 完成信号（KaTeX + 落 localStorage），不注入内容；这里给最小段落渲染。
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function recordHistoryUser(message: string): void {
  history.push({ role: "user", content: message });
}
function recordHistoryAssistantAct(text: string, calls: ParsedCall[]): void {
  const msg: HistoryMessage = { role: "assistant", content: text || undefined };
  if (calls.length > 0) {
    msg.tool_calls = calls.map((c) => ({
      id: c.id,
      type: "function",
      // 原版存储纠偏后的形态：name 恒为 "tools"、arguments 为包装 JSON 字符串
      function: { name: "tools", arguments: JSON.stringify(c.wrapper) },
    }));
  }
  history.push(msg);
}
function recordHistoryTool(callId: string, content: string): void {
  history.push({ role: "tool", tool_call_id: callId, content });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ConfirmDecision = { approved: boolean; finalContent?: string; reason?: string };

async function* chatEventStream(
  plan: ChatPlan,
  isCancelled: () => boolean,
): AsyncGenerator<string> {
  const { run, ws, acts } = plan;
  let fullResponse = "";
  // 原版先发 knowledge 事件（混合检索命中项）；HSL 侧检索在解释器内部进行
  // 且不落 artifacts —— 不伪造，跳过（协议允许零 knowledge 项）。
  let finalTextEmitted = false;

  for (const actRaw of acts) {
    const act = parseAct(actRaw);
    if (act.text) {
      fullResponse += act.text;
      yield sse({ type: "content", text: act.text });
    }
    recordHistoryAssistantAct(act.text, act.calls);
    if (act.calls.length === 0 && act.text) finalTextEmitted = true;

    for (const call of act.calls) {
      if (isCancelled()) return;
      // 1) tool_call 事件（result: null —— UI 显示「使用 xxx 中...」）
      yield sse({
        type: "tool_call",
        call_id: call.id,
        tool_name: call.toolName,
        arguments: call.wrapper,
        result: null,
      });

      let resultText: string;

      if (call.toolName === "read") {
        // read 工具回放：模型当时读到的（运行前快照）；行号语义同 fs.hsl
        const p = String(call.inner.path ?? "");
        const file = resolveInWs(ws.pristineDir, p);
        const body = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        resultText = capChars(numberLines(body), MAX_OUTPUT_CHARS);
        yield sse({ type: "tool_result", call_id: call.id, result: resultText });
        recordHistoryTool(call.id, resultText);
        continue;
      }

      if (call.toolName === "write") {
        // write：提案-审查-批准。提案内容 = applyWriteMode(模型看到的 before, …)
        // —— 与 HSL tool_write_propose 相同的计算；已用 stock 运行产物逐字节验证。
        const wPath = String(call.inner.path ?? "");
        const content = String(call.inner.content ?? "");
        const mode = String(call.inner.mode ?? "overwrite");
        const startLine = Number(call.inner.start_line ?? 0) || 0;
        const endLine = Number(call.inner.end_line ?? 0) || 0;
        const file = resolveInWs(ws.pristineDir, wPath);
        const before = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        const after = applyWriteMode(before, content, mode, startLine, endLine);

        const confirmId = randomUUID();
        let resolveFn: (d: ConfirmDecision) => void;
        const promise = new Promise<ConfirmDecision>((r) => {
          resolveFn = r;
        });
        const entry: PendingConfirm = {
          run: ws,
          isWrite: true,
          proposal: { path: wPath, after },
          resolve: resolveFn!,
          promise,
        };
        pendingConfirms.set(confirmId, entry);

        // 2) write_proposal 事件：前端打开 Code Review Panel（diff + 可编辑）
        yield sse({
          type: "write_proposal",
          confirm_id: confirmId,
          call_id: call.id,
          tool_name: "write",
          arguments: call.wrapper,
          content: after, // 完整「应用后」文件内容（原版 write tool 返回值）
        });

        // 3) 阻塞等待用户裁决（原版 confirm_queue.get()）；期间发 SSE 注释行保活
        let decision: ConfirmDecision | null = null;
        const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
        while (!decision) {
          if (isCancelled()) {
            decision = { approved: false, reason: "client-disconnected" };
            break;
          }
          const winner = await Promise.race([
            entry.promise,
            sleep(KEEPALIVE_MS).then(() => null),
          ]);
          if (winner) {
            decision = winner;
            break;
          }
          if (Date.now() > deadline) {
            decision = { approved: false, reason: "timeout" };
            break;
          }
          yield ": keepalive\n\n"; // chat.js 忽略非 data: 行
        }
        pendingConfirms.delete(confirmId);

        if (decision.approved) {
          const finalContent = decision.finalContent ?? after;
          // 权威落盘：UI 已先调 /api/write_file；此处幂等再写一次（curl 直测路径）
          const target = resolveInWs(ws.wsDir, wPath);
          if (target) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, finalContent, "utf8");
          }
          // 文案与 HSL apply_proposal 输出同构
          resultText = `approved & wrote ${wPath} (${finalContent.length} chars)`;
        } else if (plan.stock) {
          // stock 剧本：HSL 闸门已在运行中自动批准落盘——如实注明
          resultText =
            "Tool 'write' proposal was rejected by the user. (note: scripted approval had already applied this write during the HSL run; file unchanged)";
        } else {
          resultText = "Tool 'write' proposal was rejected by the user.";
        }
        yield sse({ type: "tool_result", call_id: call.id, result: resultText });
        recordHistoryTool(call.id, resultText);
        continue;
      }

      if (call.toolName === "command") {
        // 删除禁令（tools/command.hsl 逐字）；非删除命令按 HSL 语义在运行副本内执行
        const cmd = String(call.inner.command ?? "");
        const first = cmd.trim().split(/\s+/)[0] ?? "";
        if (DELETE_VERBS.includes(first)) {
          resultText = commandBlockedMessage(first);
        } else {
          const proc = Bun.spawn(["bash", "-c", cmd], {
            cwd: ws.wsDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const [out, err, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          let combined = "";
          if (out.length > 0) combined += out;
          if (err.length > 0) combined += (combined ? "\n" : "") + `[stderr]\n${err}`;
          if (combined.length === 0) combined += `(no output, exit ${code})`;
          resultText = capChars(combined, MAX_OUTPUT_CHARS);
        }
        yield sse({ type: "tool_result", call_id: call.id, result: resultText });
        recordHistoryTool(call.id, resultText);
        continue;
      }

      if (call.toolName === "add_skill") {
        const name = String(call.inner.name ?? "");
        const content = String(call.inner.content ?? "");
        resultText = `skill ${name} queued (${content.length} chars)`;
        yield sse({ type: "tool_result", call_id: call.id, result: resultText });
        recordHistoryTool(call.id, resultText);
        continue;
      }

      // search 等其余工具：解释器已执行，但网络型结果不落 artifacts——如实标注
      resultText = `(tool '${call.toolName}' executed inside scripted HSL run; output not captured by adapter)`;
      yield sse({ type: "tool_result", call_id: call.id, result: resultText });
      recordHistoryTool(call.id, resultText);
    }
  }

  if (isCancelled()) return;

  // 终答兜底：acts 未含纯文本终答（自定义剧本）时，用 report.md 的回复补流
  if (!finalTextEmitted && run.reply) {
    const reply = run.reply;
    for (let i = 0; i < reply.length; i += 48) {
      if (isCancelled()) return;
      const chunk = reply.slice(i, i + 48);
      fullResponse += chunk;
      yield sse({ type: "content", text: chunk });
      await sleep(20);
    }
    recordHistoryAssistantAct(reply, []);
  }

  // 透明脚注（scripted 解耦 + HSL 统计）——并入最后一条 assistant 历史
  const footnote = streamFootnote(plan);
  if (footnote) {
    for (let i = 0; i < footnote.length; i += 48) {
      if (isCancelled()) return;
      const chunk = footnote.slice(i, i + 48);
      fullResponse += chunk;
      yield sse({ type: "content", text: chunk });
      await sleep(20);
    }
    const last = history[history.length - 1];
    if (last && last.role === "assistant") {
      last.content = (last.content ?? "") + footnote;
    } else {
      history.push({ role: "assistant", content: footnote });
    }
  }

  // html（markdown 渲染完成信号）+ done
  yield sse({ type: "html", html: minimalMarkdown(fullResponse) });
  yield sse({ type: "done" });
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function serveStatic(rel: string): Response {
  const base = path.join(WEB_DIR, "static");
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return new Response("Not Found", { status: 404 });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return new Response("Not Found", { status: 404 });
  }
  const ext = path.extname(target).toLowerCase();
  return new Response(fs.readFileSync(target), {
    headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
  });
}

function serveTemplate(name: string): Response {
  const file = path.join(WEB_DIR, "templates", name);
  // 模板无 Jinja 占位符（已核对：无 {{ }} / {% %} / url_for）——原样输出
  return new Response(fs.readFileSync(file, "utf8"), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// 剧本选择（x-hsl-fixture header 或 body.fixture；默认 fix-notes-defer）
// ---------------------------------------------------------------------------

interface FixturePlan {
  fixturePath: string;
  stock: boolean;
  acts: string[];
  task: string;
}

function chooseFixture(
  sel: string,
  userMessage: string,
  outDir: string,
): { plan: FixturePlan } | { error: string } {
  const load = (file: string): { acts: string[]; approvals: unknown } => {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
      tracks?: { acts?: string[]; approvals?: unknown };
    };
    return { acts: data.tracks?.acts ?? [], approvals: data.tracks?.approvals ?? null };
  };

  if (sel === "" || sel === "fix-notes-defer" || sel === "default") {
    // 默认：交互式提案。acts 取自仓内 fix-notes.json，approvals 换为
    // 「延迟到 Code Review Panel」——HSL 闸门不落盘，落盘由用户批准触发
    //（与原版 /api/write_file + confirm_tool 的权威写路径一致）。
    const base = load(DEFAULT_FIXTURE);
    const fixtureCopy = path.join(outDir, "fixture.json");
    saveJson(fixtureCopy, {
      tracks: {
        acts: base.acts,
        approvals: ["reject: deferred to Code Review Panel (web UI)"],
      },
    });
    return {
      plan: { fixturePath: fixtureCopy, stock: false, acts: base.acts, task: CANONICAL_TASK },
    };
  }
  if (sel === "fix-notes") {
    // 剧本原样：approvals=["approve"]——HSL 闸门自动批准并落盘
    const base = load(DEFAULT_FIXTURE);
    return {
      plan: { fixturePath: DEFAULT_FIXTURE, stock: true, acts: base.acts, task: CANONICAL_TASK },
    };
  }
  // 自定义 fixture 路径（相对 PROJECT_ROOT 或绝对）
  const file = path.isAbsolute(sel) ? sel : path.resolve(PROJECT_ROOT, sel);
  if (!fs.existsSync(file)) return { error: `fixture not found: ${sel}` };
  const base = load(file);
  if (base.approvals !== null) {
    return { plan: { fixturePath: file, stock: true, acts: base.acts, task: userMessage } };
  }
  const fixtureCopy = path.join(outDir, "fixture.json");
  saveJson(fixtureCopy, {
    tracks: { acts: base.acts, approvals: ["reject: deferred to Code Review Panel (web UI)"] },
  });
  return { plan: { fixturePath: fixtureCopy, stock: false, acts: base.acts, task: userMessage } };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // 最长空闲（SSE 期间靠 keepalive 心跳维持）
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    // ---- 静态与页面（无鉴权） ----
    if (method === "GET" && p.startsWith("/static/")) {
      return serveStatic(p.slice("/static/".length));
    }
    if (method === "GET" && p === "/login") return serveTemplate("login.html");
    if (method === "GET" && p === "/register") return serveTemplate("register.html");
    if (method === "GET" && p === "/") return serveTemplate("index.html");
    if (method === "GET" && p === "/favicon.ico") {
      return new Response("", { status: 404 });
    }

    // ---- 认证（无鉴权） ----
    if (method === "GET" && p === "/api/public-key") {
      return json({ public_key: PUBLIC_KEY_PEM });
    }

    if (method === "POST" && p === "/api/setup") {
      if (auth.password) return json({ error: "Password already set" }, 400);
      const body = await readJsonBody(req);
      const payload = body.password;
      if (!payload) return json({ error: "Missing password" }, 400);
      if (typeof payload !== "object") {
        return json({ error: "Invalid password format (expected ECIES payload)" }, 400);
      }
      let password: string;
      try {
        password = eciesDecrypt(payload as EciesPayload);
      } catch (e) {
        return json({ error: `Decryption failed: ${(e as Error).message}` }, 400);
      }
      auth.password = hashPassword(password);
      if (!auth.jwt_secret) {
        auth.jwt_secret = randomBytes(32).toString("base64url");
      }
      persistAuth();
      return json({ status: "success", token: signJwt() });
    }

    if (method === "POST" && p === "/api/login") {
      if (!auth.password) return json({ error: "Password not set" }, 400);
      const body = await readJsonBody(req);
      const payload = body.password;
      if (!payload) return json({ error: "Missing password" }, 400);
      if (typeof payload !== "object") {
        return json({ error: "Invalid password format (expected ECIES payload)" }, 400);
      }
      let password: string;
      try {
        password = eciesDecrypt(payload as EciesPayload);
      } catch (e) {
        return json({ error: `Decryption failed: ${(e as Error).message}` }, 400);
      }
      if (checkPassword(password)) {
        return json({ status: "success", token: signJwt() });
      }
      return json({ error: "Invalid password" }, 401);
    }

    if (method === "GET" && p === "/api/check-auth") {
      const passwordSet = !!auth.password;
      const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
      let valid = false;
      if (token && passwordSet) valid = verifyJwt(token);
      return json({ password_set: passwordSet, authenticated: valid });
    }

    if (method === "GET" && p === "/api/i18n") {
      const lang = String(config.language ?? "en");
      return json(loadI18n(lang));
    }

    if (method === "GET" && p === "/session") {
      return json({ startup_id: STARTUP_ID });
    }

    // ---- /events：定时任务 SSE（心跳） ----
    // 偏差披露：原版此路由带 login_required，但 EventSource 无法携带 Bearer
    // 头（原版设置密码后会 401 循环重连并在控制台刷网络错误）。适配层放宽为
    // 开放心跳流；无调度器（MCP/定时任务不在 HSL 复现范围）。
    if (method === "GET" && p === "/events") {
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          let closed = false;
          const send = (s: string) => {
            if (!closed) {
              try {
                controller.enqueue(enc.encode(s));
              } catch {
                closed = true;
              }
            }
          };
          while (!closed) {
            await sleep(10_000);
            send(": heartbeat\n\n");
          }
        },
        cancel() {
          /* 由 start 循环的 enqueue 异常自然退出 */
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // ---- 鉴权边界（以下均为原版 login_required 端点） ----
    if (!requireAuth(req)) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ---- 聊天（SSE） ----
    if (method === "POST" && p === "/chat") {
      const body = await readJsonBody(req);
      const message = String(body.message ?? "").trim();
      if (!message) return json({ error: "Message cannot be empty" }, 400);
      const sel = req.headers.get("x-hsl-fixture") || String(body.fixture ?? "");
      const ws = newRunWorkspace();
      lastWorkspace = ws;
      const chosen = chooseFixture(sel, message, ws.outDir);
      if ("error" in chosen) return json({ error: chosen.error }, 400);
      const plan = chosen.plan;

      recordHistoryUser(message);

      // 先跑 HSL（scripted，毫秒级），再按 artifacts + acts 回放 SSE 事件
      const run = await runHsl(ws.wsDir, ws.outDir, plan.fixturePath, plan.task);
      if (!run.ok) {
        return json(
          { error: `HSL run failed (exit ${run.exitCode}): ${run.stderr.slice(0, 400)}` },
          500,
        );
      }

      let cancelled = false;
      const chatPlan: ChatPlan = {
        acts: plan.acts,
        stock: plan.stock,
        hslTask: plan.task,
        userMessage: message,
        run,
        ws,
      };
      void chatPlan.stock; //（保留字段：stock=服务端自动批；事件回放路径一致）

      const gen = chatEventStream(chatPlan, () => cancelled);
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (s: string) => {
            try {
              controller.enqueue(enc.encode(s));
            } catch {
              cancelled = true;
            }
          };
          try {
            for await (const chunk of gen) {
              if (cancelled) break;
              emit(chunk);
            }
          } catch (e) {
            emit(sse({ type: "error", text: `Agent crashed: ${(e as Error).message}` }));
          }
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        },
        cancel() {
          cancelled = true;
          // 客户端断开：唤醒挂起的提案裁决（视为拒绝——原版 GeneratorExit 同款）
          for (const [, entry] of pendingConfirms) {
            if (entry.run === ws) entry.resolve({ approved: false, reason: "client-disconnected" });
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // ---- 提案 / 命令确认（Code Review Panel 与确认按钮的回调） ----
    if (method === "POST" && p === "/api/confirm_tool") {
      const body = await readJsonBody(req);
      const confirmId = String(body.confirm_id ?? "");
      const approved = body.approved === true;
      const finalContent =
        typeof body.final_content === "string" ? (body.final_content as string) : null;
      if (!confirmId) return json({ error: "Missing confirm_id" }, 400);
      const entry = pendingConfirms.get(confirmId);
      if (!entry || !entry.promise) {
        return json({ error: "No pending confirmation found for this id" }, 404);
      }
      if (finalContent !== null) {
        // write：批准 + 用户终稿内容 → 写入运行副本工作区（幂等；UI 通常已先
        // 调 /api/write_file，二者同源同参）
        const target = entry.proposal
          ? resolveInWs(entry.run.wsDir, entry.proposal.path)
          : null;
        if (target) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, finalContent, "utf8");
        }
        entry.resolve({ approved: true, finalContent });
      } else if (approved && entry.isWrite && entry.proposal) {
        // 批准但未带终稿（确认按钮路径）：按提案 after 落盘
        const target = resolveInWs(entry.run.wsDir, entry.proposal.path);
        if (target) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entry.proposal.after, "utf8");
        }
        entry.resolve({ approved: true, finalContent: entry.proposal.after });
      } else {
        entry.resolve({ approved });
      }
      pendingConfirms.delete(confirmId);
      return json({ status: "ok" });
    }

    // ---- Code Review Panel 的文件读写（指向运行副本工作区） ----
    if (method === "POST" && p === "/api/read_file") {
      const body = await readJsonBody(req);
      const userPath = String(body.path ?? "");
      if (!userPath) return json({ error: "Missing path" }, 400);
      const wsDir = lastWorkspace?.wsDir ?? WS_SOURCE;
      const resolved = resolveInWs(wsDir, userPath);
      if (!resolved) return json({ error: "Path escapes run workspace" }, 403);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return json({ content: "" }); // 原版：不存在 → 空串
      }
      try {
        return json({ content: fs.readFileSync(resolved, "utf8") });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    if (method === "POST" && p === "/api/write_file") {
      const body = await readJsonBody(req);
      const userPath = String(body.path ?? "");
      const content = String(body.content ?? "");
      if (!userPath) return json({ error: "Missing path" }, 400);
      const wsDir = lastWorkspace?.wsDir ?? WS_SOURCE;
      const resolved = resolveInWs(wsDir, userPath);
      if (!resolved) return json({ error: "Path escapes run workspace" }, 403);
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf8");
        return json({ status: "ok" });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }

    // ---- 会话历史 ----
    if (method === "GET" && p === "/api/messages") {
      return json({ messages: history });
    }

    if (method === "POST" && p === "/api/save_partial") {
      const body = await readJsonBody(req);
      const userMessage = String(body.user_message ?? "");
      const partial = String(body.partial_response ?? "");
      if (!userMessage || !partial) {
        return json({ error: "Missing user_message or partial_response" }, 400);
      }
      history.push({ role: "assistant", content: partial });
      return json({ status: "ok" });
    }

    // ---- 配置页 ----
    if (p === "/config") {
      if (method === "GET") {
        return json(config);
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        for (const field of ["api_key", "base_url", "model"]) {
          if (!(field in body)) return json({ error: `Missing field: ${field}` }, 400);
        }
        config = { ...config, ...body };
        saveJson(configFile, config);
        return json({ status: "success" });
      }
    }

    // ---- 定时任务页（最小兼容：无调度器，仅存取） ----
    if (p === "/tasks") {
      if (method === "GET") {
        return json(tasks);
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const action = String(body.action ?? "");
        if (action === "add") {
          const time = String(body.time ?? "");
          const content = String(body.content ?? "");
          if (!time || !content) return json({ error: "Missing time or content field" }, 400);
          tasks[time] = content;
          saveJson(tasksFile, tasks);
          return json({ status: "success" });
        }
        if (action === "delete") {
          const time = String(body.time ?? "");
          if (!time) return json({ error: "Missing time field" }, 400);
          if (!(time in tasks)) return json({ error: "Task does not exist" }, 404);
          delete tasks[time];
          saveJson(tasksFile, tasks);
          return json({ status: "success" });
        }
        return json({ error: "Unknown action" }, 400);
      }
    }

    if (method === "POST" && p.startsWith("/cancel_task/")) {
      // 无后台调度器（原版 scheduler 不在 HSL 复现范围）
      return json({ error: "Task does not exist or has already ended" }, 404);
    }

    return json({ error: "Not Found" }, 404);
  },
});

console.log(`FranxAgent HSL web adapter listening on http://localhost:${server.port}`);
console.log(`  UI (verbatim, AGPL-3.0): ${WEB_DIR}/templates + ${WEB_DIR}/static`);
console.log(`  HSL backend: ${ENTRY_HSL}`);
console.log(`  default fixture: fix-notes (deferred approvals → interactive Code Review Panel)`);
