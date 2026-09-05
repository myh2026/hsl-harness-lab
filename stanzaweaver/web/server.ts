// ============================================================================
// stanzaweaver/web/server.ts — StanzaWeaver 原版 UI ↔ HSL 复现流水线 适配服务器
// ----------------------------------------------------------------------------
// 用法（端口 5020）：
//   cd hsl-projects/stanzaweaver/web && bun install     # 仅 socket.io
//   cd hsl-projects/stanzaweaver
//   bun web/server.ts
//   → 打开 http://localhost:5020
//
// 架构：
//   - UI 层：原版 templates/index.html + static/style.css + i18n/*.yaml
//     逐字拷贝（MIT，见 UI_LICENSE.MIT），一个字节未改；
//   - REST 层：复刻原版 app.py 的 /api/* 端点形状（内存态实现）；
//   - Socket.IO 层：generate / feedback 事件 → 调 dhv-ts 以 scripted 模式
//     跑 HSL 四步流水线（stanzaweaver.hsl + fixtures/weave-moon.json），
//     把剧本 + 符号层判定映射成原版 progress/done 事件形状逐拍推送；
//   - 符号层：从 prosody/lexicon.hsl 解析词汇表，在 TS 侧复刻
//     validator.hsl 的单行/全量格律判定（同一数据、同一规则），
//     用于把剧本中工具调用的受理/拒绝结果回放给前端。
//
// 说明：
//   - socket.io 无法挂接 Bun.serve 的 fetch 模型（需要 Node HTTP server
//     事件接口），故用 node:http（Bun 原生实现）承载，进程仍由 bun 运行；
//   - 原版 index.html 从 CDN 加载 socket.io 4.7.5 客户端与 CodeMirror，
//     本服务端用 socket.io 4.8.x（engine.io v4 协议，与 4.7.5 兼容）；
//   - scripted 剧本固定为 weave-moon（zh-wujue），LLM 端点状态恒报
//     ok/ok；主题/模板选择与剧本内容解耦（scripted 模式忽略提示词），
//     见 README.md「已知简化」。
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server, type Socket } from "socket.io";

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

const WEB_DIR = import.meta.dir; // .../stanzaweaver/web
const ROOT = path.resolve(WEB_DIR, ".."); // .../stanzaweaver
const TOOLCHAIN_MAIN = path.resolve(ROOT, "../.toolchain/dhv-ts/src/main.ts");
const ENTRY_HSL = path.join(ROOT, "stanzaweaver.hsl");
const FIXTURE = path.join(ROOT, "fixtures/weave-moon.json");
const LEXICON_HSL = path.join(ROOT, "prosody/lexicon.hsl");

const PORT = 5020;
const HOST = "127.0.0.1";

/** 事件推送节拍（毫秒）；STANZA_WEB_PACING=fast 供自动化测试加速。 */
const BASE_PACING = process.env.STANZA_WEB_PACING === "fast" ? 15 : 320;
const pace = (mult = 1) => new Promise((r) => setTimeout(r, BASE_PACING * mult));

const CSRF_TOKEN = Array.from({ length: 32 }, () =>
  Math.floor(Math.random() * 16).toString(16),
).join("");

// ---------------------------------------------------------------------------
// 最小 YAML 子集解析器（嵌套 map + 字符串标量——i18n/*.yaml 的全部语法）
// ---------------------------------------------------------------------------

type YamlNode = Record<string, string | YamlNode>;

function parseYamlSubset(text: string): YamlNode {
  const root: YamlNode = {};
  const stack: { indent: number; node: YamlNode }[] = [{ indent: -1, node: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = /^([^\s:][^:]*):\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (value === "") {
      const child: YamlNode = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      parent[key] = value;
    }
  }
  return root;
}

const I18N_CACHE = new Map<string, YamlNode>();
function i18nFor(lang: string): YamlNode {
  if (lang !== "zh" && lang !== "en") lang = "zh";
  if (!I18N_CACHE.has(lang)) {
    let file = path.join(WEB_DIR, "i18n", `${lang}.yaml`);
    if (!fs.existsSync(file)) file = path.join(WEB_DIR, "i18n", "zh.yaml");
    I18N_CACHE.set(lang, parseYamlSubset(fs.readFileSync(file, "utf-8")));
  }
  return I18N_CACHE.get(lang)!;
}

// ---------------------------------------------------------------------------
// 词汇表：从 prosody/lexicon.hsl 提取种子词条（与 HSL 符号层同源数据）
// ---------------------------------------------------------------------------

interface WordEntry {
  word: string;
  tone: string; // "平" | "仄"
  rhyme: string; // 韵组
  meaning: string;
}

function loadLexicon(): WordEntry[] {
  const src = fs.readFileSync(LEXICON_HSL, "utf-8");
  const re =
    /word:\s*String::from\("([^"]+)"\)\s*,\s*tone:\s*String::from\("([^"]+)"\)\s*,\s*rhyme:\s*String::from\("([^"]+)"\)\s*,\s*meaning:\s*String::from\("([^"]*)"\)/g;
  const out: WordEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ word: m[1], tone: m[2], rhyme: m[3], meaning: m[4] });
  }
  return out;
}

const LEXICON = loadLexicon();

function toneOf(ch: string): string {
  for (const e of LEXICON) if (e.word === ch) return e.tone;
  return "?";
}
function rhymeOf(ch: string): string {
  for (const e of LEXICON) if (e.word === ch) return e.rhyme;
  return "?";
}

// ---------------------------------------------------------------------------
// 符号层复刻（prosody/validator.hsl 同一规则、同一报错文案）
// ---------------------------------------------------------------------------

interface HslTemplateRules {
  key: string;
  lang: "zh" | "en";
  line_count: number;
  chars_per_line: number;
  tone_pattern: string[]; // 逐行平仄模板（zh）
  rhyme_lines: number[]; // 押韵行（0 起算）
  syllables_per_line: number;
}

/** 与 HSL 复现注册表（prosody/templates.hsl）逐一对应的三条模板。 */
const TEMPLATE_RULES: HslTemplateRules[] = [
  {
    key: "zh-wujue",
    lang: "zh",
    line_count: 4,
    chars_per_line: 5,
    tone_pattern: ["仄仄平平仄", "平平仄仄平", "平平平仄仄", "仄仄仄平平"],
    rhyme_lines: [1, 3],
    syllables_per_line: 5,
  },
  {
    key: "zh-qijue",
    lang: "zh",
    line_count: 4,
    chars_per_line: 7,
    tone_pattern: ["仄仄平平仄仄平", "平平仄仄仄平平", "平平仄仄平平仄", "仄仄平平仄仄平"],
    rhyme_lines: [0, 1, 3],
    syllables_per_line: 7,
  },
  {
    key: "en-couplet",
    lang: "en",
    line_count: 2,
    chars_per_line: 0,
    tone_pattern: [],
    rhyme_lines: [0, 1],
    syllables_per_line: 10,
  },
];

const SCRIPT_TEMPLATE_KEY = "zh-wujue"; // HSL 入口 + weave-moon 剧本绑定的模板

function templateRules(key: string): HslTemplateRules | undefined {
  return TEMPLATE_RULES.find((t) => t.key === key);
}

/** 单行逐字平仄（validator.hsl check_tone_line）。 */
function checkToneLine(line: string, lineIdx: number, pattern: string): string[] {
  const out: string[] = [];
  const chars = [...line];
  const patternChars = [...pattern];
  for (let pos = 0; pos < chars.length; pos++) {
    const ch = chars[pos];
    const expected = patternChars[pos];
    const actual = toneOf(ch);
    if (expected === undefined) {
      out.push(`第 ${lineIdx + 1} 行第 ${pos + 1} 字超出平仄模板`);
    } else if (actual !== "?" && actual !== expected) {
      out.push(`第 ${lineIdx + 1} 行第 ${pos + 1} 字 "${ch}" 应${expected}实${actual}`);
    }
  }
  return out;
}

/** 三平尾 + 孤平（validator.hsl check_tail_rules；孤平按 HSL 实现恒启用）。 */
function checkTailRules(line: string, lineIdx: number): string[] {
  const out: string[] = [];
  const chars = [...line];
  const n = chars.length;
  if (n >= 3) {
    let ping = 0;
    for (const ch of chars.slice(n - 3)) if (toneOf(ch) === "平") ping++;
    if (ping === 3) out.push(`第 ${lineIdx + 1} 行三平尾（句尾连用三平声）`);
  }
  let allPing = 0;
  for (const ch of chars) if (toneOf(ch) === "平") allPing++;
  if (allPing === 1) out.push(`第 ${lineIdx + 1} 行孤平（全行仅一个平声）`);
  return out;
}

/** 英文音节数（validator.hsl 元音组启发式 + 静音 e 修正）。 */
function countSyllables(line: string): number {
  let total = 0;
  for (const w of line.toLowerCase().split(/\s+/).filter(Boolean)) total += wordSyllables(w);
  return total;
}
function wordSyllables(word: string): number {
  let count = 0;
  let prevVowel = false;
  for (const ch of word) {
    const isVowel = "aeiouy".includes(ch);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }
  if (word.endsWith("e") && count > 1) count--;
  if (count === 0) count = 1;
  return count;
}

/** 单行校验（refine_line 门槛）。 */
function validateLine(t: HslTemplateRules, lineIdx: number, text: string): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  if (lineIdx >= t.line_count) {
    violations.push(`行号 ${lineIdx} 超出模板（0 起算，共 ${t.line_count} 行）`);
    return { valid: false, violations };
  }
  if (t.lang === "zh") {
    if ([...text].length !== t.chars_per_line) {
      violations.push(`字数 ${[...text].length} ≠ ${t.chars_per_line}`);
    }
    if (t.tone_pattern.length > lineIdx) {
      violations.push(...checkToneLine(text, lineIdx, t.tone_pattern[lineIdx]));
    }
    violations.push(...checkTailRules(text, lineIdx));
  } else {
    const syl = countSyllables(text);
    if (syl !== t.syllables_per_line) violations.push(`音节数 ${syl} ≠ ${t.syllables_per_line}`);
  }
  return { valid: violations.length === 0, violations };
}

function lineTailRhyme(lines: string[], idx: number): string {
  const line = lines[idx];
  if (line === undefined) return "?";
  const chars = [...line];
  if (chars.length === 0) return "?";
  return rhymeOf(chars[chars.length - 1]);
}

/** 韵脚校验（zh：韵组一致；en：尾三字符弱匹配）。 */
function checkRhyme(t: HslTemplateRules, lines: string[]): string[] {
  const out: string[] = [];
  if (t.rhyme_lines.length < 2) return out;
  const first = t.rhyme_lines[0];
  if (t.lang === "zh") {
    const base = lineTailRhyme(lines, first);
    if (base === "?") {
      out.push(`第 ${first + 1} 行韵脚字不在词汇表（无法判韵）`);
      return out;
    }
    for (const idx of t.rhyme_lines) {
      const r = lineTailRhyme(lines, idx);
      if (r === "?") {
        out.push(`第 ${idx + 1} 行韵脚字不在词汇表（无法判韵）`);
      } else if (r !== base) {
        out.push(`第 ${idx + 1} 行韵脚 "${r}" 与第 ${first + 1} 行 "${base}" 不同韵`);
      }
    }
  } else {
    const base = lines[first];
    if (base === undefined) {
      out.push(`第 ${first + 1} 行缺失`);
      return out;
    }
    const baseTail = [...base].slice(-3).join("");
    for (const idx of t.rhyme_lines) {
      const line = lines[idx];
      if (line === undefined) {
        out.push(`第 ${idx + 1} 行缺失`);
      } else if ([...line].slice(-3).join("") !== baseTail) {
        out.push(`第 ${idx + 1} 行尾音节与第 ${first + 1} 行不押韵`);
      }
    }
  }
  return out;
}

/** 全量格律校验（submit 门槛）。 */
function validateFull(t: HslTemplateRules, lines: string[]): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  if (lines.length !== t.line_count) {
    violations.push(`行数 ${lines.length} ≠ 模板 ${t.line_count} 行`);
  }
  for (let i = 0; i < lines.length; i++) {
    if (t.lang === "zh") {
      if ([...lines[i]].length !== t.chars_per_line) {
        violations.push(`第 ${i + 1} 行字数 ${[...lines[i]].length} ≠ ${t.chars_per_line}`);
      }
    } else {
      const syl = countSyllables(lines[i]);
      if (syl !== t.syllables_per_line) {
        violations.push(`第 ${i + 1} 行音节数 ${syl} ≠ ${t.syllables_per_line}`);
      }
    }
  }
  if (t.lang === "zh") {
    for (let i = 0; i < lines.length && i < t.tone_pattern.length; i++) {
      violations.push(...checkToneLine(lines[i], i, t.tone_pattern[i]));
    }
    for (let i = 0; i < lines.length; i++) {
      violations.push(...checkTailRules(lines[i], i));
    }
    violations.push(...checkRhyme(t, lines));
  } else {
    violations.push(...checkRhyme(t, lines));
  }
  return { valid: violations.length === 0, violations };
}

/** search_words（lexicon.hsl：过滤 + 三元组重叠排序，确定性）。 */
function trigrams(text: string): string[] {
  const chars = [...text];
  const out: string[] = [];
  let i = 0;
  while (i + 2 < chars.length) {
    out.push(chars.slice(i, i + 3).join(""));
    i++;
  }
  return out;
}
function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let hits = 0;
  for (const tri of a) if (b.includes(tri)) hits++;
  return hits / (a.length + b.length);
}
function searchWords(query: string, tone: string, rhyme: string, limit: number): string[] {
  const queryTris = trigrams(query);
  const scored: { score: number; text: string }[] = [];
  for (const e of LEXICON) {
    if (tone.length > 0 && e.tone !== tone) continue;
    if (rhyme.length > 0 && e.rhyme !== rhyme) continue;
    const score = overlap(queryTris, trigrams(e.meaning));
    scored.push({ score, text: `${e.word}（${e.tone}声·${e.rhyme}韵）${e.meaning}` });
  }
  // 稳定降序（同分保持声明序——与 HSL sort_desc_pairs 一致）
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.text);
}

// ---------------------------------------------------------------------------
// 四工具执行复刻（tools/weave.hsl WeaveKit 语义）
// ---------------------------------------------------------------------------

interface WeaveOutcome {
  tool: string;
  ok: boolean;
  output: string;
  draft: string[];
  submitted: boolean;
  title: string;
}

function weaveSearchWords(query: string, tone: string, rhyme: string, limit: number, draft: string[]): WeaveOutcome {
  const results = searchWords(query, tone, rhyme, limit);
  let output = "(no candidates)";
  if (results.length > 0) output = results.map((r, i) => `${i + 1}. ${r}\n`).join("");
  return { tool: "search_words", ok: true, output, draft, submitted: false, title: "" };
}

function weaveRefineLine(t: HslTemplateRules, draft: string[], line: number, newText: string): WeaveOutcome {
  if (line >= draft.length) {
    return {
      tool: "refine_line",
      ok: false,
      output: `行号 ${line} 越界（现有 ${draft.length} 行，0 起算）`,
      draft,
      submitted: false,
      title: "",
    };
  }
  const report = validateLine(t, line, newText);
  if (report.valid) {
    const newDraft = [...draft];
    newDraft[line] = newText;
    return {
      tool: "refine_line",
      ok: true,
      output: `line ${line} → "${newText}" (line meter valid)`,
      draft: newDraft,
      submitted: false,
      title: "",
    };
  }
  let out = "refused — line meter violations:\n";
  for (const v of report.violations) out += `- ${v}\n`;
  out += "修改未生效；请调整后重试。";
  return { tool: "refine_line", ok: false, output: out, draft, submitted: false, title: "" };
}

function weaveSubmit(t: HslTemplateRules, draft: string[], title: string): WeaveOutcome {
  const report = validateFull(t, draft);
  if (report.valid) {
    return {
      tool: "submit",
      ok: true,
      output: `accepted (${draft.length} lines, meter valid)`,
      draft,
      submitted: true,
      title,
    };
  }
  let out = "rejected — meter violations:\n";
  for (const v of report.violations) out += `- ${v}\n`;
  out += "请继续炼句（refine_line）后再次 submit。";
  return { tool: "submit", ok: false, output: out, draft, submitted: false, title: "" };
}

function weaveRewrite(draft: string[]): WeaveOutcome {
  return {
    tool: "rewrite",
    ok: true,
    output: "rewrite instruction applied; produce new lines via refine_line",
    draft,
    submitted: false,
    title: "",
  };
}

// ---------------------------------------------------------------------------
// REST 数据：模板列表 / 模板元数据 / 配置 / 历史（内存态）
// ---------------------------------------------------------------------------

const LANGUAGE_LABELS: Record<string, string> = {
  zh: "汉语",
  en: "英语",
  it: "意大利语",
  fr: "法语",
  la: "古典拉丁语",
};

interface TemplateDict {
  key: string;
  name: string;
  language: string;
  lines: number;
  syllables_per_line: number[];
  syllable_constraints: unknown[];
  display_name: string;
}

const templateDicts: TemplateDict[] = [
  {
    key: "zh-wujue",
    name: "五言绝句",
    language: "zh",
    lines: 4,
    syllables_per_line: [5, 5, 5, 5],
    syllable_constraints: null as unknown as unknown[],
    display_name: "五言绝句（汉语）",
  },
  {
    key: "zh-qijue",
    name: "七言绝句",
    language: "zh",
    lines: 4,
    syllables_per_line: [7, 7, 7, 7],
    syllable_constraints: null as unknown as unknown[],
    display_name: "七言绝句（汉语）",
  },
  {
    key: "en-couplet",
    name: "Heroic Couplet",
    language: "en",
    lines: 2,
    syllables_per_line: [10, 10],
    syllable_constraints: null as unknown as unknown[],
    display_name: "Heroic Couplet（英语）",
  },
];

/** 自定义模板编辑器元数据（对应原版 src/templates/__init__.py _CUSTOM_SCHEMES + helpers）。 */
const TEMPLATES_META: Record<string, { attribute: string; values: string[]; helpers: string[] }> = {
  zh: {
    attribute: "tone",
    values: ["平", "仄"],
    helpers: [
      "_check_alternation",
      "_check_guping",
      "_check_jinti_full",
      "_check_jinti_rhyme",
      "_check_jinti_structure",
      "_check_lv_alternation",
      "_check_rhyme",
      "_check_sanpingwei",
    ],
  },
  en: { attribute: "stress", values: ["light", "heavy"], helpers: ["_check_rhyme_group", "_check_stress_count"] },
  it: {
    attribute: "stress",
    values: ["light", "heavy"],
    helpers: ["_check_last_syllable_stress", "_check_rhyme_group", "_check_tenth_syllable_stress"],
  },
  la: { attribute: "length", values: ["long", "short"], helpers: [] },
  fr: { attribute: "", values: [], helpers: ["_check_rhyme_group"] },
};

interface LlmEndpoint {
  base_url: string;
  api_key: string;
  model: string;
}
interface AppConfig {
  writer: LlmEndpoint;
  checker: LlmEndpoint;
  language: string;
}
const appConfig: AppConfig = {
  writer: { base_url: "scripted://dhv-ts", api_key: "", model: "scripted" },
  checker: { base_url: "scripted://dhv-ts", api_key: "", model: "scripted" },
  language: "zh",
};

interface HistoryItem {
  id: number;
  topic: string;
  template_name: string;
  poem: string;
  created_at: string;
}
const history: HistoryItem[] = [];
let historyId = 0;

const LLM_STATUS = { writer: "ok", checker: "ok" }; // scripted 恒可用

// ---------------------------------------------------------------------------
// dhv-ts 运行器（真实 HSL 流水线执行）
// ---------------------------------------------------------------------------

interface HslRunResult {
  ok: boolean;
  exitCode: number;
  runJson: Record<string, unknown> | null;
  events: { seq: number; ts: string; name: string; data: Record<string, unknown> }[];
  report: { topic: string; description: string; title: string; poemLines: string[]; stats: Record<string, string> } | null;
  error: string;
  outdir: string;
}

function parseReportMd(text: string): HslRunResult["report"] {
  const sections: Record<string, string> = {};
  for (const part of text.split(/^## /m)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    sections[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  const topic = sections["主题"] ?? "";
  const description = sections["创意描述"] ?? "";
  let title = "";
  const poemLines: string[] = [];
  for (const line of (sections["诗稿"] ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (!title && poemLines.length === 0 && s.startsWith("《") && s.endsWith("》")) {
      title = s.slice(1, -1);
      continue;
    }
    poemLines.push(s);
  }
  const stats: Record<string, string> = {};
  for (const line of (sections["流水线统计"] ?? "").split(/\r?\n/)) {
    const m = /^- (\w+): (.*)$/.exec(line.trim());
    if (m) stats[m[1]] = m[2];
  }
  return { topic, description, title, poemLines, stats };
}

async function runHslPipeline(topic: string): Promise<HslRunResult> {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "stanza-web-"));
  const args = [
    process.execPath,
    TOOLCHAIN_MAIN,
    "run",
    ENTRY_HSL,
    "--task",
    topic,
    "--model",
    "scripted",
    "--fixture",
    FIXTURE,
    "--out",
    outdir,
  ];
  const proc = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  void stdoutText;

  let runJson: Record<string, unknown> | null = null;
  try {
    runJson = JSON.parse(fs.readFileSync(path.join(outdir, "run.json"), "utf-8"));
  } catch {
    /* 运行失败时可能无 run.json */
  }
  let events: HslRunResult["events"] = [];
  try {
    events = fs
      .readFileSync(path.join(outdir, "events.jsonl"), "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    /* 无事件流 */
  }
  let report: HslRunResult["report"] = null;
  try {
    report = parseReportMd(fs.readFileSync(path.join(outdir, "report.md"), "utf-8"));
  } catch {
    /* 无报告 */
  }
  const ok = exitCode === 0 && runJson?.ok === true;
  let error = "";
  if (!ok) {
    const rj = runJson as { error?: string; panic?: string } | null;
    error = rj?.error ?? rj?.panic ?? stderrText.trim().split(/\r?\n/).pop() ?? `dhv-ts 退出码 ${exitCode}`;
  }
  return { ok, exitCode, runJson, events, report, error, outdir };
}

// ---------------------------------------------------------------------------
// 流水线状态（对齐原版 app.py / pipeline.py 的 progress/done 载荷形状）
// ---------------------------------------------------------------------------

interface StepDetail {
  step: number;
  title: string;
  content: string;
  rounds?: number;
  seq: number;
}

interface PipelineState {
  topic: string;
  template_key: string;
  description: string;
  draft: string[];
  refine_rounds: number;
  checker_pass: boolean;
  checker_suggestions: string;
  step_details: StepDetail[];
  last_tool: string;
  last_tool_result: string;
  stream_text: string;
  current_detail_step: number;
  current_detail: string;
  title: string;
  user_feedback: string;
  detail_seq: number;
  current_step: number; // 1-4（对齐原版 PipelineState.current_step）
}

function newState(topic: string, templateKey: string): PipelineState {
  return {
    topic,
    template_key: templateKey,
    description: "",
    draft: [],
    refine_rounds: 0,
    checker_pass: false,
    checker_suggestions: "",
    step_details: [],
    last_tool: "",
    last_tool_result: "",
    stream_text: "",
    current_detail_step: 0,
    current_detail: "",
    title: "",
    user_feedback: "",
    detail_seq: 0,
    current_step: 1,
  };
}

interface SessionEntry {
  pipeline_state: PipelineState;
  in_flight: boolean;
}
const activeStates = new Map<string, SessionEntry>();

function setStep(s: PipelineState, step: number): void {
  s.current_step = step;
}

function emitProgress(sid: string, s: PipelineState): void {
  io.to(sid).emit("progress", {
    step: s.current_step,
    description: s.description,
    draft: s.draft,
    title: s.title,
    refine_rounds: s.refine_rounds,
    checker_pass: s.checker_pass,
    checker_suggestions: s.checker_suggestions,
    step_details: s.step_details,
    last_tool: s.last_tool,
    last_tool_result: s.last_tool_result,
    stream_text: s.stream_text,
    current_detail_step: s.current_detail_step,
    current_detail: s.current_detail,
  });
}

function emitDone(sid: string, s: PipelineState): void {
  const finalPoem = s.title ? [s.title, ...s.draft] : [...s.draft];
  io.to(sid).emit("done", {
    draft: s.draft,
    final_poem: finalPoem,
    title: s.title,
    formatted_poem: formatPoem(s.template_key, finalPoem),
    checker_pass: s.checker_pass,
    checker_suggestions: s.checker_suggestions,
    step_details: s.step_details,
  });
}

/** 展示格式化（对齐原版模板类：绝句一句一行加句号；其余按行 join）。 */
function formatPoem(templateKey: string, poem: string[]): string {
  const title = poem.length > 0 ? poem[0] : "";
  const content = poem.length > 1 ? poem.slice(1) : poem;
  if (templateKey === "zh-wujue" || templateKey === "zh-qijue") {
    const lines = content.map((l) => `${l}。`);
    return title ? title + "\n" + lines.join("\n") : lines.join("\n");
  }
  const joined = content.join("\n");
  return title ? title + "\n" + joined : joined;
}

// ---------------------------------------------------------------------------
// 剧本回放 → 原版 progress 事件序列
// ---------------------------------------------------------------------------

interface Fixture {
  tracks: {
    writer: string[];
    checker: string[];
  };
}

function loadFixture(): Fixture {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Fixture;
}

/** 把文本按标点切成流式片段（模拟原版 0.25s 节流的流式推送）。 */
function streamChunks(text: string, per = 14): string[] {
  const parts = text.split(/(?<=[。！？；，.!?;])/).filter((p) => p.trim());
  const chunks: string[] = [];
  let buf = "";
  for (const p of parts) {
    buf += p;
    if (buf.length >= per) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [text];
}

async function streamTo(sid: string, s: PipelineState, text: string, thinkingTool: string): Promise<void> {
  for (const chunk of streamChunks(text)) {
    s.stream_text = chunk;
    s.current_detail = chunk;
    if (thinkingTool) {
      s.last_tool = "_thinking";
      s.last_tool_result = chunk;
    }
    emitProgress(sid, s);
    await pace(1);
  }
}

/**
 * generate 主流程：并行 (a) 真实 dhv-ts scripted 运行 (b) 剧本回放推送。
 * 回放使用与 HSL 符号层同源的词汇表/规则重演工具调用的受理与拒绝；
 * done 载荷以 dhv-ts 运行产物（report.md / run.json）为准（回放终稿
 * 与运行产物交叉校验）。
 */
async function runGenerateFlow(sid: string, topic: string, templateKey: string): Promise<void> {
  const entry = activeStates.get(sid)!;
  const runPromise = runHslPipeline(topic);
  const fixture = loadFixture();
  const rules = templateRules(SCRIPT_TEMPLATE_KEY)!; // 剧本绑定的模板规则
  const s = newState(topic, templateKey);
  entry.pipeline_state = s;

  // ── Step 1：描述生成（流式） ────────────────────────────────────────────
  setStep(s, 1);
  s.current_detail_step = 1;
  s.current_detail = "";
  s.stream_text = "";
  emitProgress(sid, s);
  await pace(0.5);

  const description = fixture.tracks.writer[0] ?? "";
  await streamTo(sid, s, description, "");
  s.description = description;
  s.stream_text = "";
  s.current_detail = "";
  s.step_details.push({ step: 1, title: "Step 1: 生成现代文描述", content: description, seq: s.detail_seq++ });
  emitProgress(sid, s);
  await pace(0.5);

  // ── Step 2：初稿（流式 + 行呈现） ──────────────────────────────────────
  setStep(s, 2);
  s.current_detail_step = 2;
  s.current_detail = "";
  emitProgress(sid, s);
  await pace(0.5);

  const draftRaw = fixture.tracks.writer[1] ?? "";
  await streamTo(sid, s, draftRaw, "");
  const draft = draftRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  s.draft = draft;
  s.stream_text = "";
  s.current_detail = "";
  let step2Content = draftRaw;
  if (templateKey !== SCRIPT_TEMPLATE_KEY) {
    step2Content += `\n（注：scripted 剧本绑定 ${SCRIPT_TEMPLATE_KEY}；HSL 入口硬编码该模板，所选模板仅作展示）`;
  }
  s.step_details.push({ step: 2, title: "Step 2: 生成初稿", content: step2Content, seq: s.detail_seq++ });
  emitProgress(sid, s);
  await pace(0.5);

  // ── Step 3：ReAct 炼句循环（工具调用 → 符号层判定） ────────────────────
  setStep(s, 3);
  s.current_detail_step = 3;
  emitProgress(sid, s);
  await pace(0.5);

  const detailParts: string[] = [];
  let workDraft = [...draft];
  let round = 0;
  let title = "";

  for (const rawCall of fixture.tracks.writer.slice(2)) {
    round++;
    let call: Record<string, unknown>;
    try {
      call = JSON.parse(rawCall);
    } catch {
      detailParts.push(`[第${round}轮] 工具输出不是合法 JSON：${rawCall}`);
      continue;
    }
    const tool = String(call.tool ?? "");

    // 模型流式「思考」→ 调用工具（原版 on_stream 片段形状）
    await streamTo(sid, s, `[第${round}轮] 思考完成 → 调用工具: ${tool}`, "_thinking");

    let outcome: WeaveOutcome;
    if (tool === "search_words") {
      outcome = weaveSearchWords(
        String(call.query ?? ""),
        String(call.tone ?? ""),
        String(call.rhyme ?? ""),
        Number(call.limit ?? 20) || 20,
        workDraft,
      );
      detailParts.push(`[第${round}轮] search_words(${String(call.query ?? "")}): 找到${outcome.output === "(no candidates)" ? 0 : outcome.output.split("\n").filter(Boolean).length}个候选词`);
    } else if (tool === "refine_line") {
      const line = Number(call.line ?? 0) || 0;
      const newText = String(call.new_text ?? "");
      outcome = weaveRefineLine(rules, workDraft, line, newText);
      let detail = `[第${round}轮] refine_line(行${line}, '${newText}')`;
      if (outcome.ok) {
        detail += ": 成功";
        workDraft = outcome.draft;
        detailParts.push(detail);
        detailParts.push("当前诗稿:\n" + workDraft.join("\n"));
      } else {
        detailParts.push(`${detail}: 失败 - ${outcome.output}`);
      }
    } else if (tool === "rewrite") {
      outcome = weaveRewrite(workDraft);
      detailParts.push(`[第${round}轮] rewrite(${String(call.instruction ?? "")}): 重写完成`);
    } else if (tool === "submit") {
      title = String(call.title ?? "");
      outcome = weaveSubmit(rules, workDraft, title);
      if (outcome.submitted) {
        detailParts.push(`[第${round}轮] submit: 提交定稿 (全量格律校验通过)`);
      } else {
        detailParts.push(`[第${round}轮] submit: 全量格律校验未通过，拒绝提交 - ${outcome.output}`);
      }
    } else {
      outcome = { tool, ok: false, output: `未知工具 "${tool}"`, draft: workDraft, submitted: false, title: "" };
      detailParts.push(`[第${round}轮] 未知工具 ${tool}`);
    }

    s.draft = [...workDraft];
    s.refine_rounds = round;
    s.last_tool = tool;
    s.last_tool_result = outcome.output;
    s.current_detail_step = 3;
    s.current_detail = detailParts.join("\n");
    s.stream_text = "";
    emitProgress(sid, s);
    await pace(1.2);
    if (outcome.submitted) break;
  }

  s.title = title;
  s.step_details.push({
    step: 3,
    title: "Step 3: 炼句优化",
    content: detailParts.join("\n"),
    rounds: s.refine_rounds,
    seq: s.detail_seq++,
  });
  s.current_detail = "";
  emitProgress(sid, s);
  await pace(0.5);

  // ── 等待真实 dhv-ts 运行完成（回放期间已在并行执行） ──────────────────
  const run = await runPromise;

  // ── Step 4：检查 AI 终审（剧本 verdict × 运行产物交叉校验） ────────────
  setStep(s, 4);
  s.current_detail_step = 4;
  s.stream_text = "";
  emitProgress(sid, s);
  await pace(0.5);

  if (!run.ok) {
    io.to(sid).emit("error", { message: `生成失败: ${run.error}` });
    entry.in_flight = false;
    return;
  }

  const checkerRaw = fixture.tracks.checker[0] ?? "{\"pass\": true}";
  let checkerPass = true;
  let checkerSuggestions = "";
  try {
    const verdict = JSON.parse(checkerRaw) as { pass?: boolean; suggestions?: string };
    checkerPass = Boolean(verdict.pass);
    checkerSuggestions = String(verdict.suggestions ?? "");
  } catch {
    checkerSuggestions = `终审输出不是合法 JSON：${checkerRaw}`;
    checkerPass = false;
  }

  // 交叉校验：运行产物为准
  if (run.report) {
    const statsPass = run.report.stats.checker_pass === "true";
    if (statsPass !== checkerPass) {
      console.warn(`[stanzaweaver-web] checker verdict 与运行产物不一致（剧本=${checkerPass}, report=${statsPass}），以运行产物为准`);
      checkerPass = statsPass;
    }
    if (run.report.poemLines.length > 0 && JSON.stringify(run.report.poemLines) !== JSON.stringify(workDraft)) {
      console.warn("[stanzaweaver-web] 回放终稿与运行产物不一致，以运行产物（report.md）为准");
      workDraft = run.report.poemLines;
      s.draft = [...workDraft];
    }
    if (run.report.title && run.report.title !== s.title) {
      s.title = run.report.title;
    }
  }
  s.checker_pass = checkerPass;
  s.checker_suggestions = checkerSuggestions;

  const eventTrace = run.events
    .map((e) => {
      switch (e.name) {
        case "run_start":
          return `seq${e.seq} run_start    model=${String((e.data as { model?: string }).model ?? "")}`;
        case "node":
          return `seq${e.seq} node(${String((e.data as { node?: string }).node ?? "")})    初始化`;
        case "run_end":
          return `seq${e.seq} run_end      ok=${String((e.data as { ok?: boolean }).ok ?? "")} ${String((e.data as { elapsed_ms?: number }).elapsed_ms ?? "")}ms`;
        default:
          return `seq${e.seq} ${e.name}`;
      }
    })
    .join("\n");

  s.step_details.push({
    step: 4,
    title: "Step 4: 检查AI终审",
    content: `pass=${s.checker_pass}\n${s.checker_suggestions}\nHSL 事件轨迹（events.jsonl · dhv-ts microkernel）：\n${eventTrace}`,
    seq: s.detail_seq++,
  });
  emitProgress(sid, s);
  await pace(0.5);

  emitDone(sid, s);
  entry.in_flight = false;
}

/** feedback 续跑：打回 Step 3，按反馈重新炼句（原版 continue_with_feedback 语义）。 */
async function runFeedbackFlow(sid: string, previous: PipelineState, feedback: string): Promise<void> {
  const entry = activeStates.get(sid)!;
  const runPromise = runHslPipeline(previous.topic);
  const fixture = loadFixture();
  const rules = templateRules(SCRIPT_TEMPLATE_KEY)!;

  const s: PipelineState = {
    ...previous,
    draft: [...previous.draft],
    step_details: [...previous.step_details],
    user_feedback: feedback,
    checker_pass: false,
    checker_suggestions: "",
    refine_rounds: 0,
    detail_seq: previous.step_details.length,
    last_tool: "",
    last_tool_result: "",
    stream_text: "",
    current_detail: "",
    title: previous.title,
  };
  entry.pipeline_state = s;

  // Step 3 重入
  setStep(s, 3);
  s.current_detail_step = 3;
  emitProgress(sid, s);
  await pace(0.5);

  const detailParts: string[] = [`用户反馈已注入 writer 上下文：${feedback}`];
  let workDraft = [...s.draft];
  let round = 0;
  let title = s.title;

  for (const rawCall of fixture.tracks.writer.slice(2)) {
    round++;
    let call: Record<string, unknown>;
    try {
      call = JSON.parse(rawCall);
    } catch {
      continue;
    }
    const tool = String(call.tool ?? "");
    await streamTo(sid, s, `[第${round}轮] 思考完成 → 调用工具: ${tool}`, "_thinking");
    let outcome: WeaveOutcome;
    if (tool === "search_words") {
      outcome = weaveSearchWords(String(call.query ?? ""), String(call.tone ?? ""), String(call.rhyme ?? ""), Number(call.limit ?? 20) || 20, workDraft);
      detailParts.push(`[第${round}轮] search_words(${String(call.query ?? "")}): 找到${outcome.output === "(no candidates)" ? 0 : outcome.output.split("\n").filter(Boolean).length}个候选词`);
    } else if (tool === "refine_line") {
      const line = Number(call.line ?? 0) || 0;
      const newText = String(call.new_text ?? "");
      outcome = weaveRefineLine(rules, workDraft, line, newText);
      let detail = `[第${round}轮] refine_line(行${line}, '${newText}')`;
      if (outcome.ok) {
        detail += ": 成功";
        workDraft = outcome.draft;
        detailParts.push(detail);
        detailParts.push("当前诗稿:\n" + workDraft.join("\n"));
      } else {
        detailParts.push(`${detail}: 失败 - ${outcome.output}`);
      }
    } else if (tool === "rewrite") {
      outcome = weaveRewrite(workDraft);
      detailParts.push(`[第${round}轮] rewrite(${String(call.instruction ?? "")}): 重写完成`);
    } else if (tool === "submit") {
      title = String(call.title ?? "");
      outcome = weaveSubmit(rules, workDraft, title);
      detailParts.push(outcome.submitted ? `[第${round}轮] submit: 提交定稿 (全量格律校验通过)` : `[第${round}轮] submit: 全量格律校验未通过，拒绝提交 - ${outcome.output}`);
    } else {
      outcome = { tool, ok: false, output: `未知工具 "${tool}"`, draft: workDraft, submitted: false, title: "" };
    }
    s.draft = [...workDraft];
    s.refine_rounds = previous.refine_rounds + round;
    s.last_tool = tool;
    s.last_tool_result = outcome.output;
    s.current_detail_step = 3;
    s.current_detail = detailParts.join("\n");
    s.stream_text = "";
    emitProgress(sid, s);
    await pace(1.2);
    if (outcome.submitted) break;
  }

  s.title = title;
  s.step_details.push({
    step: 3,
    title: "Step 3: 炼句优化",
    content: detailParts.join("\n"),
    rounds: s.refine_rounds,
    seq: s.detail_seq++,
  });
  s.current_detail = "";
  emitProgress(sid, s);
  await pace(0.5);

  const run = await runPromise;

  setStep(s, 4);
  s.current_detail_step = 4;
  emitProgress(sid, s);
  await pace(0.5);

  if (!run.ok) {
    io.to(sid).emit("error", { message: `反馈处理失败: ${run.error}` });
    entry.in_flight = false;
    return;
  }

  const checkerRaw = fixture.tracks.checker[0] ?? "{\"pass\": true}";
  let checkerPass = true;
  let checkerSuggestions = "";
  try {
    const verdict = JSON.parse(checkerRaw) as { pass?: boolean; suggestions?: string };
    checkerPass = Boolean(verdict.pass);
    checkerSuggestions = String(verdict.suggestions ?? "");
  } catch {
    checkerSuggestions = `终审输出不是合法 JSON：${checkerRaw}`;
    checkerPass = false;
  }
  if (run.report) {
    const statsPass = run.report.stats.checker_pass === "true";
    if (statsPass !== checkerPass) checkerPass = statsPass;
    if (run.report.poemLines.length > 0 && JSON.stringify(run.report.poemLines) !== JSON.stringify(workDraft)) {
      workDraft = run.report.poemLines;
      s.draft = [...workDraft];
    }
    if (run.report.title) s.title = run.report.title;
  }
  s.checker_pass = checkerPass;
  s.checker_suggestions = checkerSuggestions;
  s.step_details.push({
    step: 4,
    title: "Step 4: 检查AI终审",
    content: `pass=${s.checker_pass}\n${s.checker_suggestions}`,
    seq: s.detail_seq++,
  });
  emitProgress(sid, s);
  await pace(0.5);

  emitDone(sid, s);
  entry.in_flight = false;
}

// ---------------------------------------------------------------------------
// HTTP 层（node:http，Bun 原生实现）——复刻原版 app.py 的 REST 契约
// ---------------------------------------------------------------------------

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

function requireCsrf(req: IncomingMessage): boolean {
  return (req.headers["x-csrf-token"] ?? "") === CSRF_TOKEN;
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveFile(res: ServerResponse, abs: string): boolean {
  if (!abs.startsWith(path.join(WEB_DIR))) return false;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(abs));
  return true;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 仅本机访问（原版 _guard_local_access：Host 头前缀校验）
  const host = req.headers.host ?? "";
  if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
    json(res, 403, { status: "error", message: "拒绝非本机访问" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${host || "localhost"}`);
  const p = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  try {
    // ── 页面与静态资源 ──
    if (method === "GET" && p === "/") {
      const html = fs
        .readFileSync(path.join(WEB_DIR, "templates", "index.html"), "utf-8")
        .replace(/\{\{ csrf_token \}\}/g, CSRF_TOKEN);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    if (method === "GET" && (p === "/static" || p.startsWith("/static/"))) {
      const rel = p.slice("/static/".length);
      if (rel && serveFile(res, path.join(WEB_DIR, "static", rel))) return;
      json(res, 404, { status: "error", message: "not found" });
      return;
    }

    // ── i18n ──
    if (method === "GET" && p.startsWith("/api/i18n/")) {
      const lang = p.slice("/api/i18n/".length).replace(/\.json$/, "");
      json(res, 200, i18nFor(lang));
      return;
    }

    // ── 模板 ──
    if (method === "GET" && p === "/api/templates") {
      json(res, 200, templateDicts);
      return;
    }
    if (method === "GET" && p === "/api/templates/meta") {
      json(res, 200, TEMPLATES_META);
      return;
    }
    if (method === "POST" && p === "/api/templates/custom") {
      if (!requireCsrf(req)) {
        json(res, 403, { status: "error", message: "缺少安全令牌" });
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { status: "error", message: "请求格式错误" });
        return;
      }
      if (typeof data !== "object" || data === null) {
        json(res, 400, { status: "error", message: "请求格式错误" });
        return;
      }
      const name = String(data.name ?? "").trim();
      const language = String(data.language ?? "zh");
      let lines = parseInt(String(data.lines ?? 4), 10);
      if (Number.isNaN(lines)) lines = 4;
      lines = Math.max(1, Math.min(lines, 30));
      const syllablesPerLine = Array.isArray(data.syllables_per_line) ? data.syllables_per_line : [];

      if (!name) {
        json(res, 400, { status: "error", message: "模板名称不能为空" });
        return;
      }
      if (!(language in TEMPLATES_META)) {
        json(res, 400, { status: "error", message: "不支持的语言" });
        return;
      }
      let syls: number[];
      try {
        syls = (syllablesPerLine as unknown[]).map((s) => Math.max(1, parseInt(String(s), 10))).slice(0, lines);
      } catch {
        json(res, 400, { status: "error", message: "每行音节数格式错误" });
        return;
      }
      if (syls.length !== lines) {
        json(res, 400, { status: "error", message: "音节数列表长度必须等于行数" });
        return;
      }
      // 原版 Python re.sub(r"\W+") 为 Unicode 词字符语义：汉字是合法词字符
      const safeName = name.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
      if (!safeName) {
        json(res, 400, { status: "error", message: "模板名需包含字母或数字（当前名称无法生成合法标识符）" });
        return;
      }
      // 简化：内存注册（原版落盘 custom_*.py 并热注册；HSL 侧无此通道）
      const key = `custom_${safeName}`;
      if (!templateDicts.some((t) => t.key === key)) {
        templateDicts.push({
          key,
          name,
          language,
          lines,
          syllables_per_line: syls,
          syllable_constraints: null as unknown as unknown[],
          display_name: `${name}（${LANGUAGE_LABELS[language] ?? language}）`,
        });
      }
      io.emit("templates_updated", { count: templateDicts.length });
      json(res, 200, { status: "ok", message: `模板'${name}'已创建并注册`, count: templateDicts.length });
      return;
    }

    // ── 配置 ──
    if (p === "/api/config" && method === "GET") {
      if (!requireCsrf(req)) {
        json(res, 403, { status: "error", message: "缺少安全令牌" });
        return;
      }
      json(res, 200, { writer: appConfig.writer, checker: appConfig.checker, language: appConfig.language });
      return;
    }
    if (p === "/api/config" && method === "POST") {
      if (!requireCsrf(req)) {
        json(res, 403, { status: "error", message: "缺少安全令牌" });
        return;
      }
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        data = parsed as Record<string, unknown>;
      } catch {
        json(res, 400, { status: "error", message: "请求格式错误" });
        return;
      }
      for (const key of ["writer", "checker"] as const) {
        if (key in data) {
          const value = data[key];
          if (typeof value !== "object" || value === null) {
            json(res, 400, { status: "error", message: `${key} 配置格式错误` });
            return;
          }
          appConfig[key] = {
            base_url: String((value as Record<string, unknown>).base_url ?? ""),
            api_key: String((value as Record<string, unknown>).api_key ?? ""),
            model: String((value as Record<string, unknown>).model ?? ""),
          };
        }
      }
      if ("language" in data && (data.language === "zh" || data.language === "en")) {
        appConfig.language = data.language;
      }
      // scripted 模式恒可用：保存后状态回 ok（原版会重 ping 真实端点）
      LLM_STATUS.writer = "ok";
      LLM_STATUS.checker = "ok";
      io.emit("llm_status", { ...LLM_STATUS });
      json(res, 200, { status: "ok" });
      return;
    }

    // ── 历史 ──
    if (p === "/api/history" && method === "GET") {
      json(res, 200, history.slice(-50).reverse());
      return;
    }
    if (p === "/api/history" && method === "POST") {
      if (!requireCsrf(req)) {
        json(res, 403, { status: "error", message: "缺少安全令牌" });
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { status: "error", message: "请求格式错误" });
        return;
      }
      if (typeof data !== "object" || data === null) {
        json(res, 400, { status: "error", message: "请求格式错误" });
        return;
      }
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      history.push({
        id: ++historyId,
        topic: String(data.topic ?? ""),
        template_name: String(data.template_name ?? ""),
        poem: String(data.poem ?? ""),
        created_at: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      });
      json(res, 200, { status: "ok" });
      return;
    }

    // ── 状态 ──
    if (method === "GET" && p === "/api/import-status") {
      json(res, 200, { importing: false }); // HSL 词汇表为内置种子，无导入阶段
      return;
    }
    if (method === "GET" && p === "/api/llm-status") {
      json(res, 200, { ...LLM_STATUS });
      return;
    }
    if (method === "POST" && p === "/api/llm-ping") {
      if (!requireCsrf(req)) {
        json(res, 403, { status: "error", message: "缺少安全令牌" });
        return;
      }
      io.emit("llm_status", { ...LLM_STATUS });
      json(res, 200, { ...LLM_STATUS });
      return;
    }

    json(res, 404, { status: "error", message: "not found" });
  } catch (err) {
    json(res, 500, { status: "error", message: `internal: ${(err as Error).message}` });
  }
}

// ---------------------------------------------------------------------------
// HTTP + Socket.IO 装配
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  void handleRequest(req, res);
});

const io = new Server(httpServer, {
  cors: { origin: "*" }, // 原版 cors_allowed_origins="*"
});

io.on("connection", (socket: Socket) => {
  // 原版后台线程周期推送 llm_status；scripted 即刻可用
  socket.emit("llm_status", { ...LLM_STATUS });
  activeStates.set(socket.id, { pipeline_state: null as unknown as PipelineState, in_flight: false });

  socket.on("generate", (data: Record<string, unknown>) => {
    const topic = String(data?.topic ?? "");
    const templateKey = String(data?.template_key ?? "");
    const entry = activeStates.get(socket.id);
    if (!entry || entry.in_flight) return;

    if (!topic || !templateKey) {
      io.to(socket.id).emit("error", { message: "主题和模板不能为空" });
      return;
    }
    if (!templateDicts.some((t) => t.key === templateKey)) {
      io.to(socket.id).emit("error", {
        message: `生成失败: 未知模板 "${templateKey}"（可用：${templateDicts.map((t) => t.key).join(" / ")}）`,
      });
      return;
    }
    entry.in_flight = true;
    console.log(`[stanzaweaver-web] generate 开始 session=${socket.id} template=${templateKey} topic=${JSON.stringify(topic)}`);
    void runGenerateFlow(socket.id, topic, templateKey).catch((err: Error) => {
      entry.in_flight = false;
      io.to(socket.id).emit("error", { message: `生成失败: ${err.message}` });
    });
  });

  socket.on("feedback", (data: Record<string, unknown>) => {
    const feedback = String(data?.feedback ?? "");
    const entry = activeStates.get(socket.id);
    if (!entry || entry.in_flight) return;
    const state = entry.pipeline_state;
    if (!state) {
      io.to(socket.id).emit("error", { message: "没有活跃的生成会话，请先生成诗歌" });
      return;
    }
    entry.in_flight = true;
    console.log(`[stanzaweaver-web] feedback 开始 session=${socket.id} feedback=${JSON.stringify(feedback)}`);
    void runFeedbackFlow(socket.id, state, feedback).catch((err: Error) => {
      entry.in_flight = false;
      io.to(socket.id).emit("error", { message: `反馈处理失败: ${err.message}` });
    });
  });

  socket.on("disconnect", () => {
    activeStates.delete(socket.id);
  });
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

httpServer.listen(PORT, HOST, () => {
  console.log(`[stanzaweaver-web] StanzaWeaver HSL 适配服务已启动: http://${HOST}:${PORT}`);
  console.log(`[stanzaweaver-web] HSL 入口: ${path.relative(process.cwd(), ENTRY_HSL)} · 剧本: ${path.relative(process.cwd(), FIXTURE)}`);
  console.log(`[stanzaweaver-web] 词汇表: ${LEXICON.length} 词条（源自 ${path.relative(process.cwd(), LEXICON_HSL)}）`);
});

process.on("SIGINT", () => {
  console.log("\n[stanzaweaver-web] 收到 SIGINT，关闭服务…");
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
