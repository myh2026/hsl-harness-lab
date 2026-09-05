/* ============================================================================
 * DSH web shell — HSL 复现版视觉复刻（vanilla JS，无依赖）
 * ----------------------------------------------------------------------------
 * 交互模型（对应原版各插件承担的职责，此处合并为单文件）：
 *   - BootPage     → boot 序列（arc 增长 + 卸载）
 *   - ThemePresenter → body[data-ds-dark-theme] + html color-scheme
 *   - AppFrame     → 侧栏折叠（280px ↔ 56px rail）
 *   - ConversationRoot → 内容宽度轴 --dsh-conversation-column-width（ResizeObserver）
 *   - Sessions     → 内存会话列表（刷新即重置，与任务的简化约定一致）
 *   - ChatView     → transcript 渲染：用户气泡 / assistant markdown / 工具调用卡
 *   - InputBar     → composer 自适应高度 + 发送
 *
 * 后端契约（web/server.ts）：
 *   POST /api/chat  body {message: string, fixture?: string}
 *   → {ok, events: [{type:'tool', tool, args, input, output, ok}
 *                    | {type:'assistant', text}
 *                    | {type:'error', text}],
 *       report: {ok, verdict, turns, tool_calls, bash_calls, failures,
 *                events_logged, elapsed_ms}}
 * ========================================================================== */
(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)

  /* ---------- 常量 ---------- */
  const THEME_KEY = 'dsh-replica-theme'
  const SIDEBAR_KEY = 'dsh-replica-sidebar-collapsed'

  const TOOL_META = {
    list_files: { title: '列目录', summary: (a) => a.path ?? 'workspace' },
    read_file: { title: '读取', summary: (a) => a.path ?? '' },
    edit_file: { title: '编辑', summary: (a) => a.path ?? '' },
    bash: { title: '终端', summary: (a) => a.command ?? '' },
  }

  const TOOL_ICONS = {
    list_files:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.75 4.75c0-.55.45-1 1-1h3.1l1.4 1.6h5c.55 0 1 .45 1 1v5.4c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1V4.75Z" stroke="currentColor" stroke-width="1.3"/></svg>',
    read_file:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 2.75c0-.55.45-1 1-1h4.2L12.5 5.5v7.75c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1V2.75Z" stroke="currentColor" stroke-width="1.3"/><path d="M8.5 2v3.5H12" stroke="currentColor" stroke-width="1.3"/></svg>',
    edit_file:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13h2.2l6.6-6.6-2.2-2.2L3 10.8V13Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.9 4.1l2 2" stroke="currentColor" stroke-width="1.3"/></svg>',
    bash:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    default:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.5v5M5.5 8h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  }

  const CHEVRON =
    '<svg class="toolChevron" viewBox="0 0 14 14" width="14" height="14" fill="none" aria-hidden="true"><path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  /* ---------- 工具函数 ---------- */
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))

  /** 相对时间（简版 relative-time）。 */
  function relTime(ts) {
    const diff = Date.now() - ts
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    return `${Math.floor(diff / 86_400_000)} 天前`
  }

  /* ---------- 迷你 markdown（代码块 / 行内码 / 加粗 / 斜体 / 链接 / 标题 / 列表） ---------- */
  function renderMarkdown(src) {
    const root = document.createElement('div')
    root.className = 'markdown'
    const lines = String(src ?? '').split('\n')
    let i = 0

    const flushParagraph = (buf) => {
      if (buf.length === 0) return
      const p = document.createElement('p')
      p.innerHTML = inlineMarkdown(buf.join('\n'))
      root.appendChild(p)
    }

    const inlineMarkdown = (text) => {
      let out = escapeHtml(text)
      out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')
      out = out.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<strong>$1</strong>')
      out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      out = out.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      )
      return out
    }

    let para = []
    while (i < lines.length) {
      const line = lines[i]

      // 围栏代码块
      const fence = line.match(/^```(\w*)\s*$/)
      if (fence) {
        flushParagraph(para); para = []
        i += 1
        const code = []
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code.push(lines[i])
          i += 1
        }
        i += 1 // 跳过收尾 ```
        root.appendChild(buildCodeBlock(fence[1] || 'text', code.join('\n')))
        continue
      }

      // 标题
      const heading = line.match(/^(#{1,4})\s+(.*)$/)
      if (heading) {
        flushParagraph(para); para = []
        const h = document.createElement(`h${heading[1].length}`)
        h.innerHTML = inlineMarkdown(heading[2])
        root.appendChild(h)
        i += 1
        continue
      }

      // 列表
      const listMatch = line.match(/^\s*[-*]\s+(.*)$/)
      if (listMatch) {
        flushParagraph(para); para = []
        const ul = document.createElement('ul')
        while (i < lines.length) {
          const m = lines[i].match(/^\s*[-*]\s+(.*)$/)
          if (!m) break
          const li = document.createElement('li')
          li.innerHTML = inlineMarkdown(m[1])
          ul.appendChild(li)
          i += 1
        }
        root.appendChild(ul)
        continue
      }

      // 空行 = 段落边界
      if (line.trim() === '') {
        flushParagraph(para)
        para = []
        i += 1
        continue
      }

      para.push(line)
      i += 1
    }
    flushParagraph(para)
    return root
  }

  /** 代码块（CodeBlock 复刻：banner 语言标签 + 复制按钮 + pre）。 */
  function buildCodeBlock(lang, code) {
    const block = document.createElement('div')
    block.className = 'md-code-block'
    const banner = document.createElement('div')
    banner.className = 'codeBanner'
    const langSpan = document.createElement('span')
    langSpan.className = 'codeLang'
    langSpan.textContent = lang
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'codeCopy'
    copy.textContent = '复制'
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = '已复制'
        setTimeout(() => { copy.textContent = '复制' }, 1500)
      }).catch(() => {})
    })
    banner.append(langSpan, copy)
    const pre = document.createElement('pre')
    const codeEl = document.createElement('code')
    codeEl.textContent = code
    pre.appendChild(codeEl)
    block.append(banner, pre)
    return block
  }

  /* ---------- DOM 结构构建 ---------- */
  const messageColumn = $('messageColumn')
  const chatScroll = $('chatScroll')
  const scrollBody = $('scrollBody')
  const sessionListEl = $('sessionList')
  const sessionTitleCrumb = $('sessionTitleCrumb')
  const composerInput = $('composerInput')
  const sendBtn = $('sendBtn')
  const sidebarRoot = $('sidebarRoot')
  const themeToggleBtn = $('themeToggleBtn')
  const themeToggleLabel = $('themeToggleLabel')
  const themeIconMoon = $('themeIconMoon')
  const themeIconSun = $('themeIconSun')
  const conversationRoot = $('conversationRoot')

  /** 会话内存态。 */
  const sessions = []
  let currentSession = null
  let running = false

  function newSession() {
    const s = {
      id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      title: '新会话',
      createdAt: Date.now(),
      items: [], // 渲染好的 DOM 节点容器
    }
    sessions.unshift(s)
    currentSession = s
    switchTo(s)
    renderSessionList()
    composerInput.focus()
    return s
  }

  function switchTo(s) {
    currentSession = s
    messageColumn.replaceChildren()
    for (const node of s.items) messageColumn.appendChild(node)
    sessionTitleCrumb.textContent = s.title
    updatePhase()
    renderSessionList()
  }

  function renderSessionList() {
    sessionListEl.replaceChildren()
    for (const s of sessions) {
      const row = document.createElement('div')
      row.className = 'sessionRow' + (s === currentSession ? ' selected' : '')
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      row.title = s.title
      const slot = document.createElement('span')
      slot.className = 'slot'
      const title = document.createElement('span')
      title.className = 'title'
      title.textContent = s.title
      const time = document.createElement('span')
      time.className = 'time'
      time.textContent = relTime(s.createdAt)
      row.append(slot, title, time)
      const activate = () => { if (s !== currentSession) switchTo(s) }
      row.addEventListener('click', activate)
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
      })
      sessionListEl.appendChild(row)
    }
  }

  /** 空会话 = hero（composer 居中）；有内容 = active。 */
  function updatePhase() {
    const hasContent = currentSession !== null && currentSession.items.length > 0
    if (hasContent) scrollBody.dataset.phase = 'active'
    else scrollBody.dataset.phase = 'hero'
  }

  function flowItem() {
    const el = document.createElement('div')
    el.className = 'flowItem'
    return el
  }

  function appendItem(node) {
    messageColumn.appendChild(node)
    currentSession.items.push(node)
    updatePhase()
    chatScroll.scrollTop = chatScroll.scrollHeight
  }

  /* ---------- 消息渲染 ---------- */
  function appendUserMessage(text) {
    const item = flowItem()
    const row = document.createElement('div')
    row.className = 'userRow'
    const stack = document.createElement('div')
    stack.className = 'userStack'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = text
    stack.appendChild(bubble)
    row.appendChild(stack)
    item.appendChild(row)
    appendItem(item)
  }

  function appendAssistantMessage(text) {
    const item = flowItem()
    const body = document.createElement('div')
    body.className = 'assistantBody'
    body.appendChild(renderMarkdown(text))
    item.appendChild(body)
    appendItem(item)
  }

  function appendTurnStatus() {
    const item = flowItem()
    item.dataset.role = 'turn-status'
    const status = document.createElement('div')
    status.className = 'turnStatus'
    status.textContent = '正在运行…'
    item.appendChild(status)
    messageColumn.appendChild(item)
    chatScroll.scrollTop = chatScroll.scrollHeight
    return item
  }

  function appendErrorRow(message) {
    const item = flowItem()
    const row = document.createElement('div')
    row.className = 'turnErrorRow'
    const dot = document.createElement('span')
    dot.className = 'stateDot turnErrorDot'
    dot.dataset.state = 'error'
    dot.setAttribute('aria-hidden', 'true')
    const copy = document.createElement('div')
    copy.className = 'turnErrorCopy'
    const title = document.createElement('span')
    title.className = 'turnErrorTitle'
    title.textContent = '错误'
    const msg = document.createElement('span')
    msg.className = 'turnErrorMessage'
    msg.textContent = message
    copy.append(title, msg)
    row.append(dot, copy)
    item.appendChild(row)
    appendItem(item)
  }

  /** 工具调用卡（ToolRow + DisclosureRow 复刻）。 */
  function appendToolCard(ev) {
    const meta = TOOL_META[ev.tool] ?? { title: ev.tool, summary: (a) => JSON.stringify(a) }
    const summaryText = ev.ok === false
      ? (ev.output ?? '失败').split('\n')[0]
      : meta.summary(ev.args ?? {})

    const item = flowItem()
    const root = document.createElement('div')
    root.className = 'toolRoot'
    root.dataset.state = ev.ok === false ? 'error' : 'done'

    const row = document.createElement('div')
    row.className = 'toolRow'
    row.dataset.expandable = ''
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-expanded', 'false')

    const leading = document.createElement('span')
    leading.className = 'toolLeading'
    if (ev.ok === false) {
      const dot = document.createElement('span')
      dot.className = 'stateDot'
      dot.dataset.state = 'error'
      dot.setAttribute('aria-hidden', 'true')
      leading.appendChild(dot)
    } else {
      const iconIdle = document.createElement('span')
      iconIdle.className = 'toolIconIdle'
      iconIdle.innerHTML = TOOL_ICONS[ev.tool] ?? TOOL_ICONS.default
      leading.appendChild(iconIdle)
    }
    leading.insertAdjacentHTML('beforeend', CHEVRON)

    const title = document.createElement('span')
    title.className = 'toolTitle'
    title.textContent = meta.title

    const sep = document.createElement('span')
    sep.className = 'toolSep'
    sep.setAttribute('aria-hidden', 'true')

    const summary = document.createElement('span')
    summary.className = 'toolSummary'
    summary.textContent = summaryText
    if (ev.ok === false) summary.dataset.error = ''

    row.append(leading, title, sep, summary)

    // 展开体：IN/OUT 卡
    const body = document.createElement('div')
    body.className = 'toolBody'
    body.hidden = true

    const ioCard = document.createElement('div')
    ioCard.className = 'ioCard'
    const inSection = document.createElement('div')
    inSection.className = 'ioSection'
    const inLabel = document.createElement('span')
    inLabel.className = 'ioLabel'
    inLabel.textContent = '输入'
    const inText = document.createElement('span')
    inText.className = 'ioText'
    inText.textContent = ev.input ?? JSON.stringify(ev.args ?? {}, null, 2)
    inSection.append(inLabel, inText)
    ioCard.appendChild(inSection)

    if (ev.output != null && ev.output !== '') {
      const divider = document.createElement('span')
      divider.className = 'ioDivider'
      divider.setAttribute('aria-hidden', 'true')
      const outSection = document.createElement('div')
      outSection.className = 'ioSection'
      const outLabel = document.createElement('span')
      outLabel.className = 'ioLabel'
      outLabel.textContent = '输出'
      const outText = document.createElement('span')
      outText.className = 'ioText'
      outText.textContent = ev.output
      if (ev.ok === false) outText.dataset.error = ''
      outSection.append(outLabel, outText)
      ioCard.append(divider, outSection)
    }
    body.appendChild(ioCard)

    const toggle = () => {
      const open = body.hidden
      body.hidden = !open
      if (open) root.dataset.open = 'true'
      else delete root.dataset.open
      row.setAttribute('aria-expanded', String(open))
    }
    row.addEventListener('click', toggle)
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
    })

    root.append(row, body)
    item.appendChild(root)
    appendItem(item)
  }

  /** 运行结束的 stats 行（StatsLine 复刻）。 */
  function appendStatsLine(report) {
    if (!report) return
    const item = flowItem()
    const line = document.createElement('div')
    line.className = 'statsLine'
    const parts = []
    const sep = () => { const s = document.createElement('span'); s.className = 'statsSep'; s.textContent = '·'; return s }
    const push = (text, cls, data) => {
      const span = document.createElement('span')
      if (cls) span.className = cls
      if (data) span.dataset.verdict = data
      span.textContent = text
      parts.push(span)
    }
    push(`${report.turns ?? 0} turns`)
    parts.push(sep())
    push(`${report.tool_calls ?? 0} tool_calls`)
    parts.push(sep())
    push(`${report.bash_calls ?? 0} bash`)
    parts.push(sep())
    push(`${report.events_logged ?? 0} events`)
    if (report.elapsed_ms != null) {
      parts.push(sep())
      push(`${report.elapsed_ms} ms`)
    }
    if (report.verdict) {
      parts.push(sep())
      push(`verdict: ${report.verdict}`, 'statsVerdict', report.verdict)
    }
    for (const p of parts) line.appendChild(p)
    item.appendChild(line)
    appendItem(item)
  }

  /* ---------- 发送 ---------- */
  async function send() {
    const text = composerInput.value.trim()
    if (text === '' || running) return
    running = true
    sendBtn.disabled = true
    composerInput.value = ''
    autosize()

    // 乐观插入 user 气泡
    appendUserMessage(text)
    if (currentSession.title === '新会话') {
      currentSession.title = text.length > 24 ? `${text.slice(0, 24)}…` : text
      sessionTitleCrumb.textContent = currentSession.title
      renderSessionList()
    }

    const statusItem = appendTurnStatus()
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      statusItem.remove()
      for (const ev of data.events ?? []) {
        if (ev.type === 'tool') appendToolCard(ev)
        else if (ev.type === 'assistant') appendAssistantMessage(ev.text ?? '')
        else if (ev.type === 'error') appendErrorRow(ev.text ?? 'unknown error')
      }
      appendStatsLine(data.report)
      if (!data.ok && (data.events ?? []).length === 0) {
        appendErrorRow('harness 运行失败，详见 server 控制台')
      }
    } catch (err) {
      statusItem.remove()
      appendErrorRow(String(err && err.message ? err.message : err))
    } finally {
      running = false
      updateSendState()
      composerInput.focus()
    }
  }

  /* ---------- Composer 行为 ---------- */
  function autosize() {
    const el = composerInput
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 336 - 4)}px`
    updateSendState()
  }

  function updateSendState() {
    sendBtn.disabled = running || composerInput.value.trim() === ''
  }

  composerInput.addEventListener('input', autosize)
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  })
  sendBtn.addEventListener('click', send)

  /* ---------- 侧栏 ---------- */
  $('newSessionBtn').addEventListener('click', newSession)
  $('brandBtn').addEventListener('click', newSession)

  function setSidebarCollapsed(collapsed) {
    if (collapsed) sidebarRoot.dataset.collapsed = 'true'
    else delete sidebarRoot.dataset.collapsed
    document.querySelector('.frame')?.toggleAttribute('data-sidebar-collapsed', collapsed)
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0') } catch { /* ignore */ }
  }

  $('toggleSidebarBtn').addEventListener('click', () => {
    setSidebarCollapsed(!('collapsed' in sidebarRoot.dataset))
  })

  /* ---------- 主题 ---------- */
  function applyTheme(dark) {
    if (dark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    themeIconMoon.hidden = dark
    themeIconSun.hidden = !dark
    themeToggleLabel.textContent = dark ? '浅色模式' : '深色模式'
  }

  function initTheme() {
    let pref = null
    try { pref = localStorage.getItem(THEME_KEY) } catch { /* ignore */ }
    const dark = pref !== null
      ? pref === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches
    applyTheme(dark)
  }

  themeToggleBtn.addEventListener('click', () => {
    const next = !document.body.hasAttribute('data-ds-dark-theme')
    applyTheme(next)
    try { localStorage.setItem(THEME_KEY, next ? 'dark' : 'light') } catch { /* ignore */ }
  })

  /* ---------- 内容宽度轴（原版 ResizeObserver → --dsh-conversation-column-width） ---------- */
  function observeColumn() {
    const publish = () => {
      const w = conversationRoot.getBoundingClientRect().width
      if (w > 0) conversationRoot.style.setProperty('--dsh-conversation-column-width', `${Math.round(w)}px`)
    }
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(publish).observe(conversationRoot)
    }
    publish()
  }

  /* ---------- Boot 序列（BootPage 复刻：arc 72° → 288° 单调增长） ---------- */
  function runBoot() {
    const boot = $('boot')
    const spinner = document.querySelector('[data-dsh-boot-spinner]')
    const hint = boot.querySelector('.bootHint')
    const total = 6 // 模拟 loader 条目数
    const arcFor = (n) => `${Math.round(72 + (Math.min(n, total) / total) * 216)}deg`
    let active = 0
    spinner.style.setProperty('--dsh-boot-arc', arcFor(0))
    const steps = ['ui-theme', 'ui-layout', 'ui-sidebar', 'ui-conversation', 'ui-chat', 'ui-tool']
    const timer = setInterval(() => {
      active += 1
      spinner.style.setProperty('--dsh-boot-arc', arcFor(active))
      if (hint) hint.textContent = `Loading plugins… (${Math.min(active, total)}/${total})`
      if (active >= total) {
        clearInterval(timer)
        setTimeout(() => {
          boot.remove()
          const app = $('app')
          app.hidden = false
          composerInput.focus()
        }, 160)
      }
    }, 110)
  }

  /* ---------- 启动 ---------- */
  initTheme()
  try {
    if (localStorage.getItem(SIDEBAR_KEY) === '1') setSidebarCollapsed(true)
  } catch { /* ignore */ }
  observeColumn()
  newSession()
  runBoot()
})()
