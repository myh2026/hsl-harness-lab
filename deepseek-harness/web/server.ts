/**
 * DSH web 复刻适配层 — Bun 原生 HTTP 服务器（`Bun.serve`，无框架、无外部依赖）。
 * ---------------------------------------------------------------------------
 * 用法：
 *   cd /home/z/my-project/hsl-projects/deepseek-harness
 *   bun web/server.ts
 *   # → http://localhost:5030/  （静态服务 web/replica/）
 *
 * 路由：
 *   GET  /            → web/replica/index.html（视觉复刻前端）
 *   GET  /app.css /app.js /logo.svg
 *   GET  /api/health  → {"ok":true}
 *   POST /api/chat    body {"message": string, "fixture"?: string}
 *        → 复制 workspace 到 /tmp/dsh-web-ws<rand>（并重置 stats.ts 为剧本设计
 *          的“待修复”初始态，防污染、每次可复现），用 dhv-ts 跑 dsh.hsl
 *          （--model scripted --fixture），产物写 /tmp/dsh-web-run<rand>，
 *          解析 transcript.jsonl + report.md + events.jsonl，
 *          返回 {"ok", "events": [...], "report": {...}, "runner": [...]}。
 *
 * events 元素（app.js 配套渲染）：
 *   {type:"tool",      tool, args, input, output, ok}
 *   {type:"assistant", text}
 *   {type:"error",     text}
 *
 * 说明：
 *   - runner 生命周期事件（run_start/run_end 等）来自 events.jsonl；
 *     模型/工具轮次在 transcript.jsonl —— 两者都回传。
 *   - fixture 可在请求体覆盖（必须是 repro fixtures/ 下的文件名），
 *     默认 fix-variance.json。
 * ---------------------------------------------------------------------------
 * 原项目：https://github.com/deepseek-ai/deepseek-harness（MIT）。
 * 本文件是 HSL 复现项目的适配层，不属于原仓库。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'

const WEB_DIR = dirname(import.meta.path) // …/deepseek-harness/web
const REPLICA_DIR = join(WEB_DIR, 'replica')
const PROJECT_DIR = dirname(WEB_DIR) // …/deepseek-harness
const HSL_PROJECTS = dirname(PROJECT_DIR) // …/hsl-projects
const TOOLCHAIN_MAIN = resolve(HSL_PROJECTS, '.toolchain/dhv-ts/src/main.ts')
const ENTRY = join(PROJECT_DIR, 'dsh.hsl')
const FIXTURES_DIR = join(PROJECT_DIR, 'fixtures')
const WORKSPACE_SRC = join(PROJECT_DIR, 'workspace')

const PORT = 5030
const DEFAULT_FIXTURE = 'fix-variance.json'
const RUN_TIMEOUT_MS = 60_000

/**
 * 剧本设计的工作区初始态（README「待修复任务工作区」）。
 *
 * 说明：repro 的 workspace/stats.ts 目前处于一次历史验证运行后的“已修复”态
 * （Task 2 端到端验证写回过），此时 fixture 的 edit_file old_text 匹配不到。
 * 本适配层在 /tmp 临时副本上把它重置回设计的初始态，保证剧本按原设计走完
 * 5 次工具调用（list/read/read/edit/bash）且测试全 PASS。
 * 不改动 repro 目录内的任何文件。
 */
const INITIAL_STATS_TS = `// 小型统计库（待修复：variance 分母错误 + median 缺失）
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.reduce((a, x) => a + x, 0);
  return s / xs.length;
}

// BUG: 样本方差应为 n-1 分母，这里误用了 n
export function variance(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  const s = xs.reduce((a, x) => a + (x - m) ** 2, 0);
  return s / xs.length;
}

// TODO: 缺失 median 实现
`

/** 静态文件表（白名单，杜绝目录穿越）。 */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/logo.svg': { file: 'logo.svg', type: 'image/svg+xml' },
}

interface UiEvent {
  type: 'tool' | 'assistant' | 'error'
  tool?: string
  args?: Record<string, unknown>
  input?: string
  output?: string | null
  ok?: boolean | null
  text?: string
}

interface RunReport {
  ok: boolean
  verdict?: string
  turns?: number
  tool_calls?: number
  bash_calls?: number
  failures?: number
  events_logged?: number
  elapsed_ms?: number
}

/** 解析 transcript.jsonl → UI 事件数组。 */
function parseTranscript(text: string): UiEvent[] {
  const events: UiEvent[] = []
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  for (const line of lines) {
    let entry: { role: string; content: string }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.role === 'assistant') {
      let action: Record<string, unknown>
      try {
        action = JSON.parse(entry.content)
      } catch {
        // 非严格 JSON 的回复按普通 assistant 文本渲染
        events.push({ type: 'assistant', text: entry.content })
        continue
      }
      if (action.action === 'tool' && typeof action.tool === 'string') {
        const { action: _a, tool, ...args } = action
        events.push({ type: 'tool', tool: tool as string, args, ok: null, output: null })
      } else if (action.action === 'done') {
        events.push({ type: 'assistant', text: String(action.summary ?? '') })
      } else {
        events.push({ type: 'assistant', text: entry.content })
      }
    } else if (entry.role === 'tool') {
      // 结果行格式："[tool <name> <args 摘要>] ok|FAILED\n<正文>"
      const nl = entry.content.indexOf('\n')
      const head = nl === -1 ? entry.content : entry.content.slice(0, nl)
      const body = nl === -1 ? '' : entry.content.slice(nl + 1)
      const failed = /FAILED/.test(head)
      const lastPending = [...events].reverse().find((e) => e.type === 'tool' && e.ok === null)
      if (lastPending) {
        lastPending.ok = !failed
        lastPending.output = body
      }
    }
  }
  return events
}

/** 解析 report.md 的预算小节。 */
function parseReport(text: string, elapsedMs: number | undefined): RunReport {
  const report: RunReport = { ok: false }
  const verdict = text.match(/- verdict:\s*(\w+)/)
  if (verdict) report.verdict = verdict[1]
  const num = (key: string): number | undefined => {
    const m = text.match(new RegExp(`- ${key}:\\s*(\\d+)`))
    return m ? Number(m[1]) : undefined
  }
  report.turns = num('turns')
  report.tool_calls = num('tool_calls')
  report.bash_calls = num('bash_calls')
  report.failures = num('failures')
  report.events_logged = num('events_logged')
  report.elapsed_ms = elapsedMs
  report.ok = verdict?.[1] === 'accepted'
  return report
}

/** 读文件容错。 */
function tryRead(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 一次 /api/chat：跑 dhv-ts → 产物 → UI 事件。 */
async function runHarness(message: string, fixtureName: string): Promise<Response> {
  const rnd = Math.random().toString(36).slice(2, 10)
  const wsDir = `/tmp/dsh-web-ws-${rnd}`
  const outDir = `/tmp/dsh-web-run-${rnd}`
  try {
    // 1) 工作区临时副本（防污染） + 重置为剧本初始态
    mkdirSync(dirname(wsDir), { recursive: true })
    cpSync(WORKSPACE_SRC, wsDir, { recursive: true })
    writeFileSync(join(wsDir, 'stats.ts'), INITIAL_STATS_TS)

    // 2) 跑 dhv-ts（scripted 剧本）
    const proc = Bun.spawn(
      [
        'bun', TOOLCHAIN_MAIN, 'run', ENTRY,
        '--workspace', wsDir,
        '--task', message,
        '--model', 'scripted',
        '--fixture', join(FIXTURES_DIR, fixtureName),
        '--out', outDir,
      ],
      { cwd: PROJECT_DIR, stdout: 'pipe', stderr: 'pipe', timeout: RUN_TIMEOUT_MS },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    // 3) 产物解析
    const transcript = tryRead(join(outDir, 'transcript.jsonl'))
    const reportText = tryRead(join(outDir, 'report.md'))
    const runJson = tryRead(join(outDir, 'run.json'))
    const eventsJsonl = tryRead(join(outDir, 'events.jsonl'))
    let elapsedMs: number | undefined
    try {
      elapsedMs = runJson ? (JSON.parse(runJson).elapsed_ms as number | undefined) : undefined
    } catch { /* run.json 缺失或损坏时用 undefined */ }

    if (transcript === null || reportText === null) {
      const detail = stderr.trim().split('\n').slice(-5).join('\n') || stdout.trim().split('\n').slice(-5).join('\n')
      return Response.json(
        {
          ok: false,
          events: [{ type: 'error', text: `dhv-ts 运行失败（exit=${exitCode}）${detail ? `：${detail}` : ''}` }],
          report: { ok: false, elapsed_ms: elapsedMs },
          runner: [] as unknown[],
        },
        { status: 200 },
      )
    }

    const events = parseTranscript(transcript)
    const report = parseReport(reportText, elapsedMs)
    const runner: unknown[] = []
    for (const line of (eventsJsonl ?? '').split('\n')) {
      if (line.trim() === '') continue
      try { runner.push(JSON.parse(line)) } catch { /* 跳过残行 */ }
    }

    return Response.json({ ok: report.ok, events, report, runner })
  } finally {
    // 4) 清理临时目录（尽力而为）
    try { rmSync(wsDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(outDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === 'GET' && (url.pathname === '/api/health')) {
      return Response.json({ ok: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let body: { message?: unknown; fixture?: unknown }
      try {
        body = await req.json()
      } catch {
        return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
      }
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (message === '') {
        return Response.json({ ok: false, error: 'message 必须是非空字符串' }, { status: 400 })
      }
      // fixture 覆盖：仅允许 repro fixtures/ 下的直接文件名
      let fixture = DEFAULT_FIXTURE
      if (typeof body.fixture === 'string' && body.fixture !== '') {
        const name = basename(body.fixture)
        if (/^[\w.-]+\.json$/.test(name) && existsSync(join(FIXTURES_DIR, name))) {
          fixture = name
        } else {
          return Response.json({ ok: false, error: `fixture 不存在：${name}` }, { status: 400 })
        }
      }
      return runHarness(message, fixture)
    }

    if (req.method === 'GET') {
      const entry = STATIC_FILES[url.pathname]
      if (entry) {
        const file = join(REPLICA_DIR, entry.file)
        const content = tryRead(file)
        if (content !== null) {
          return new Response(content, { headers: { 'content-type': entry.type } })
        }
      }
      return new Response('not found', { status: 404 })
    }

    return new Response('method not allowed', { status: 405 })
  },
})

console.log(`[dsh-web] replica UI  → http://localhost:${server.port}/`)
console.log(`[dsh-web] health      → http://localhost:${server.port}/api/health`)
console.log(`[dsh-web] chat        → POST http://localhost:${server.port}/api/chat`)
console.log(`[dsh-web] entry=${ENTRY}`)
console.log(`[dsh-web] toolchain=${TOOLCHAIN_MAIN}`)
