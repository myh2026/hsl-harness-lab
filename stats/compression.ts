// 压缩率统计：原项目核心源码 vs HSL 复现
// 口径（公开披露）：
//   LOC = 非空行（含注释/版权头，两侧一致）
//   原项目侧 = 复现所映射的核心产品源码，排除 tests/fixtures/snapshots/docs/锁文件/配置
//   HSL 侧   = *.hsl + 内嵌原生 TS（workspace/*.ts）
//   前端 UI  = 原版逐字拷贝，不计入压缩率（DSH 为视觉复刻，单列参考）
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const REPOS = '/tmp/hsl_repos'
const PROJ = '/home/z/my-project/hsl-projects'

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function loc(files: string[]): number {
  let n = 0
  for (const f of files) {
    const txt = readFileSync(f, 'utf8')
    for (const line of txt.split('\n')) if (line.trim().length > 0) n++
  }
  return n
}

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.py'])
const EXCL_SEG = [
  'node_modules', '.git', 'tests', '__tests__', 'fixtures', 'snapshots',
  'stress-tests', 'docs', '.github', 'reference', 'examples',
]

function collect(dir: string, exts: Set<string>): string[] {
  if (!existsSync(dir)) return []
  if (statSync(dir).isFile()) {
    return exts.has(extname(dir)) ? [dir] : []
  }
  return walk(dir).filter(f => {
    if (!exts.has(extname(f))) return false
    const segs = f.split('/')
    if (segs.some(s => EXCL_SEG.includes(s) || s.endsWith('.spec.ts') || s.endsWith('.e2e.ts') || s.endsWith('.test.ts'))) return false
    if (f.endsWith('.d.ts')) return false
    return true
  })
}

interface Row {
  key: string
  name: string
  origFiles: number
  origLoc: number
  hslFiles: number
  hslLoc: number
  nativeTsLoc: number
  replicaLoc: number
  origUiLoc: number
  rate: number
}

function project(
  key: string,
  name: string,
  origDirs: string[],
  hslDir: string,
  origUiDirs: string[] = [],
  replicaDir?: string,
): Row {
  const orig = origDirs.flatMap(d => collect(d, CODE_EXT))
  const hsl = collect(hslDir, new Set(['.hsl']))
  const native = collect(join(hslDir, 'workspace'), new Set(['.ts'])).filter(
    f => !f.endsWith('.test.ts'),
  )
  const ui = origUiDirs.flatMap(d => collect(d, new Set(['.html', '.css', '.js', '.py'])))
  const replica = replicaDir ? collect(replicaDir, new Set(['.html', '.css', '.js', '.svg'])) : []
  const hslLoc = loc(hsl) + loc(native)
  const origLoc = loc(orig)
  return {
    key, name,
    origFiles: orig.length, origLoc,
    hslFiles: hsl.length + native.length, hslLoc,
    nativeTsLoc: loc(native),
    replicaLoc: loc(replica),
    origUiLoc: loc(ui),
    rate: 1 - hslLoc / origLoc,
  }
}

const dsh = project(
  'dsh', 'deepseek-harness',
  [
    `${REPOS}/deepseek-harness/packages/core`,
    `${REPOS}/deepseek-harness/packages/guard`,
    `${REPOS}/deepseek-harness/packages/llm/llm`,
    `${REPOS}/deepseek-harness/packages/bundle`,
    `${REPOS}/deepseek-harness/packages/session/session-log-deepseek`,
    `${REPOS}/deepseek-harness/packages/session/session-persistence`,
    `${REPOS}/deepseek-harness/packages/session/session-persistence-jsonl`,
  ],
  `${PROJ}/deepseek-harness`,
  [],
  `${PROJ}/deepseek-harness/web/replica`,
)
const franx = project(
  'franx', 'FranxAgent',
  [`${REPOS}/FranxAgent/src`, `${REPOS}/FranxAgent/knowledge`],
  `${PROJ}/franxagent`,
  [`${REPOS}/FranxAgent/src/templates`, `${REPOS}/FranxAgent/src/static`],
)
const stanza = project(
  'stanza', 'StanzaWeaver',
  [`${REPOS}/StanzaWeaver/src`, `${REPOS}/StanzaWeaver/app.py`],
  `${PROJ}/stanzaweaver`,
  [`${REPOS}/StanzaWeaver/templates`, `${REPOS}/StanzaWeaver/static`],
)

const rows = [dsh, franx, stanza]
const totalOrig = rows.reduce((a, r) => a + r.origLoc, 0)
const totalHsl = rows.reduce((a, r) => a + r.hslLoc, 0)

console.log(JSON.stringify({
  rows,
  total: {
    origLoc: totalOrig,
    hslLoc: totalHsl,
    rate: 1 - totalHsl / totalOrig,
  },
}, null, 2))
