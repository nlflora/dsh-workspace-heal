/**
 * dsh-workspace-heal
 *
 * Two capabilities, both driven from the agent side:
 *
 *  1. Auto-heal: when a workspace folder disappeared but the workspace still owns
 *     sessions, recreate the folder (mkdir -p). Sessions keep their recorded cwd,
 *     so nothing else has to change. Workspaces with zero bound sessions are never
 *     touched — a folder the user created and deleted on purpose stays deleted.
 *
 *  2. Context import: list sessions that no longer belong to any workspace, and
 *     turn one of them into a compact summary that the caller can paste into the
 *     current conversation. The old session log is only ever read, never written.
 */

import fs from 'node:fs'

export const name = 'workspace-heal'
export const inject = ['workspaceRegistry', 'sessionPersistence', 'tools']

const DEFAULTS = {
  autoHeal: true,
  intervalSeconds: 60,
  digestMaxChars: 1800,
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so they can be unit-tested without a Harness)
// ---------------------------------------------------------------------------

/** Normalize a directory path for comparison; Windows paths are case-insensitive. */
export function normalizePath(input) {
  if (typeof input !== 'string' || input.length === 0) return ''
  let value = input.replace(/\//g, '\\').replace(/\\+$/, '')
  if (process.platform === 'win32') value = value.toLowerCase()
  return value
}

/** Collapse whitespace and cut a string to a readable length. */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

/** Extract plain text blocks from one message-shaped value. */
function messageText(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Text the Harness injects into a user message (runtime context, memory snapshot,
 * skill catalog) is not something the user asked. Drop it before summarizing.
 */
export function isInjectedBlock(text) {
  const value = String(text ?? '').trimStart()
  if (!value) return false
  if (value.startsWith('<system-reminder>')) return true
  if (value.startsWith('<runtime-memory-file')) return true
  if (value.startsWith('<available_skills>')) return true
  if (value.startsWith('[MNEMON]')) return true
  if (value.includes('MNEMON RUNTIME MEMORY SNAPSHOT')) return true
  if (value.startsWith('Current runtime context')) return true
  if (value.startsWith('Current DSH file policy')) return true
  if (value.startsWith('Tokens prefixed with @')) return true
  return false
}

/** User-authored text only: injected context blocks are removed. */
function userMessageText(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text && !isInjectedBlock(text))
    .join('\n')
}

/** Fold a session event list into the counters the digest needs. */
export function summarizeEvents(events) {
  const list = Array.isArray(events) ? events : []
  const userTexts = []
  const assistantTexts = []
  const tools = new Map()
  let turns = 0

  for (const event of list) {
    if (!event || typeof event.type !== 'string') continue
    if (event.type === 'turn/start') {
      turns += 1
      continue
    }
    if (event.type === 'user/message') {
      const text = userMessageText(event.data)
      if (text) userTexts.push(text)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data && event.data.message)
      if (text) assistantTexts.push(text)
      continue
    }
    if (event.type === 'tool/call') {
      const toolName = event.data && event.data.name
      if (typeof toolName === 'string' && toolName) {
        tools.set(toolName, (tools.get(toolName) || 0) + 1)
      }
    }
  }

  return { turns, userTexts, assistantTexts, tools }
}

/**
 * Build a human-readable digest of one old session.
 * Deterministic: no model call, no network, no writes.
 */
export function buildDigest({ header, events, maxChars = 1800 } = {}) {
  const { turns, userTexts, assistantTexts, tools } = summarizeEvents(events)
  const firstUser = userTexts.length > 0 ? clip(userTexts[0], 240) : ''
  const recentUser = userTexts.slice(-3).map((text) => clip(text, 140)).filter(Boolean)
  const recentAssistant = assistantTexts.slice(-3).map((text) => clip(text, 200)).filter(Boolean)
  const toolNames = [...tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([toolName, count]) => `${toolName}×${count}`)

  const lines = []
  lines.push('## 旧会话上下文（摘要导入）')
  if (header && header.cwd) lines.push(`- 原工作区：${header.cwd}`)
  if (header && header.createdAt) lines.push(`- 创建时间：${new Date(header.createdAt).toLocaleString()}`)
  lines.push(
    `- 规模：${turns} 轮 / ${userTexts.length} 条用户消息 / ${assistantTexts.length} 条回复 / ${
      toolNames.length > 0 ? tools.size : 0
    } 种工具`,
  )
  if (firstUser) lines.push(`- 最初目标：${firstUser}`)
  if (recentUser.length > 0) {
    lines.push('- 最近的请求：')
    for (const text of recentUser) lines.push(`  - ${text}`)
  }
  if (recentAssistant.length > 0) {
    lines.push('- 最近的结论：')
    for (const text of recentAssistant) lines.push(`  - ${text}`)
  }
  if (toolNames.length > 0) lines.push(`- 用过的工具：${toolNames.join(', ')}`)
  lines.push('')
  lines.push('> 以上是从旧会话自动提取的摘要，不是逐字记录；旧会话本身未被修改。')

  const text = lines.join('\n')
  const budget = Math.max(400, Number(maxChars) || DEFAULTS.digestMaxChars)
  return text.length <= budget ? text : text.slice(0, budget) + '\n…（摘要已截断）'
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

/**
 * Drop everything a lossless-JSON wire cannot carry: undefined members,
 * non-finite numbers, functions and symbols.
 */
export function jsonSafe(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  return null
}

/**
 * Recreate missing workspace directories.
 *
 * `registry` only needs `list()`; each entry needs `path`, `status()` and
 * `sessionIds`. `mkdir` defaults to the real filesystem, so a test can pass a
 * stub registry and still exercise the real write path.
 */
export async function healWorkspaces({ registry, source = 'manual', mkdir, logger } = {}) {
  const result = { source, checked: 0, healed: [], skipped: [] }
  if (!registry || typeof registry.list !== 'function') {
    return { ...result, error: 'workspaceRegistry 不可用' }
  }
  const makeDirectory =
    typeof mkdir === 'function' ? mkdir : (target) => fs.mkdirSync(target, { recursive: true })
  const reasonOf = (error) => String(error && error.message ? error.message : error)

  let workspaces = []
  try {
    workspaces = registry.list()
  } catch (error) {
    return { ...result, error: reasonOf(error) }
  }

  for (const workspace of workspaces) {
    result.checked += 1
    const bound = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0
    if (bound === 0) continue // never recreate a folder that owns no session

    let status
    try {
      status = await workspace.status()
    } catch {
      result.skipped.push({ path: workspace.path, reason: 'status-error' })
      continue
    }
    if (status !== 'missing-dir') continue

    try {
      makeDirectory(workspace.path)
      result.healed.push({ id: workspace.id, path: workspace.path, sessions: bound })
      if (logger && typeof logger.info === 'function') {
        logger.info(`[workspace-heal] 已重建工作区目录：${workspace.path}（${bound} 个会话）`)
      }
    } catch (error) {
      result.skipped.push({ path: workspace.path, reason: reasonOf(error) })
    }
  }
  return result
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const log = ctx.logger ?? console
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')

  if (!registry || !persistence) {
    log.warn?.('[workspace-heal] workspaceRegistry / sessionPersistence 不可用，插件不激活')
    return
  }

  // ---- auto heal -----------------------------------------------------------

  const healOnce = (source) => healWorkspaces({ registry, source, logger: log })

  ctx.effect(() => {
    if (settings.autoHeal === false) return () => {}
    const intervalMs = Math.max(10, Number(settings.intervalSeconds) || 60) * 1000
    const run = () => {
      healOnce('timer').catch(() => {})
    }
    const firstRun = setTimeout(run, 3000)
    const repeating = setInterval(run, intervalMs)
    return () => {
      clearTimeout(firstRun)
      clearInterval(repeating)
    }
  })

  // ---- session helpers -----------------------------------------------------

  function workspacePathSet() {
    const set = new Set()
    for (const workspace of registry.list()) {
      const key = normalizePath(workspace.path)
      if (key) set.add(key)
    }
    return set
  }

  async function listSnapshots() {
    const snapshots = await persistence.list()
    return Array.isArray(snapshots) ? snapshots : []
  }

  async function listOrphans(limit) {
    const owned = workspacePathSet()
    const snapshots = await listSnapshots()
    const orphans = []
    for (const snapshot of snapshots) {
      const header = snapshot && snapshot.header ? snapshot.header : undefined
      if (!header || !header.cwd) continue
      if (header.origin === 'subagent') continue
      const key = normalizePath(header.cwd)
      if (key && owned.has(key)) continue
      orphans.push({
        sessionId: header.id,
        cwd: header.cwd,
        createdAt: header.createdAt || 0,
        eventCount: typeof snapshot.eventCount === 'number' ? snapshot.eventCount : undefined,
        sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : undefined,
      })
    }
    orphans.sort((a, b) => b.createdAt - a.createdAt)
    const cap = Math.max(1, Math.min(200, Number(limit) || 30))
    return orphans.slice(0, cap)
  }

  /** Read a bounded slice: the head and the tail of the log. */
  async function readEvents(id, maxEvents = 400) {
    const handle = await persistence.open(id, 'read')
    try {
      const snapshot = await persistence.stat(id)
      const total = snapshot && typeof snapshot.eventCount === 'number' ? snapshot.eventCount : 0
      if (total > maxEvents) {
        const half = Math.floor(maxEvents / 2)
        const head = await handle.read(0, half)
        const tail = await handle.read(Math.max(0, total - half), half)
        return [...(head.events || []), ...(tail.events || [])]
      }
      const all = await handle.read()
      return all.events || []
    } finally {
      await handle.close().catch(() => {})
    }
  }

  async function digestOf(sessionId, maxChars) {
    const snapshot = await persistence.stat(sessionId)
    if (!snapshot) throw new Error(`会话不存在：${sessionId}`)
    const events = await readEvents(sessionId)
    return {
      sessionId,
      header: snapshot.header,
      eventCount: snapshot.eventCount,
      digest: buildDigest({
        header: snapshot.header,
        events,
        maxChars: Number(maxChars) || settings.digestMaxChars,
      }),
    }
  }

  // ---- tool ----------------------------------------------------------------

  const tool = {
    name: 'workspace_heal',
    description:
      '工作区自愈 + 旧会话上下文导入。\n' +
      'action=status：列出所有工作区、目录是否存在、绑定了多少会话；同时给出可导入的孤儿会话数量。\n' +
      'action=list：列出「已不属于任何工作区」的会话（文件夹被改名/删除/移动后留下的），按最近活跃排序。\n' +
      'action=preview：给一个 sessionId，返回该会话的摘要（不含原文，不修改旧会话）。先把摘要给用户看，等用户确认再导入。\n' +
      'action=import：给一个 sessionId，返回带标记的摘要正文；把这段正文原样放进你的回复，它就成为当前会话的上下文。\n' +
      'action=heal：立即执行一次目录检查与重建（不等定时器）。\n' +
      '本工具的写操作只有两个：给「绑定了会话」且目录缺失的工作区建目录；其余全部只读。旧会话日志任何时候都不会被改写。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list', 'preview', 'import', 'heal'],
          description: '要执行的动作',
        },
        sessionId: {
          type: 'string',
          description: 'preview / import 时要读取的旧会话 id',
        },
        limit: {
          type: 'integer',
          description: 'list 返回的最大条数，默认 30',
        },
        maxChars: {
          type: 'integer',
          description: '摘要的最大字符数，默认 1800',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const payload = value && typeof value === 'object' ? value : { value }
        const text =
          typeof payload.body === 'string'
            ? payload.body
            : typeof payload.digest === 'string'
              ? payload.digest
              : JSON.stringify(payload, null, 2)
        return [{ type: 'text', text }]
      },
    },
    async execute(args = {}) {
      return jsonSafe(await runTool(args))
    },
  }

  async function runTool(args = {}) {
      const action = String(args.action || '').trim()

      if (action === 'status') {
        const workspaces = registry.list().map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
          sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
        }))
        const statuses = []
        for (const workspace of registry.list()) {
          let status = 'unknown'
          try {
            status = await workspace.status()
          } catch {
            status = 'error'
          }
          statuses.push({
            title: workspace.title,
            path: workspace.path,
            status,
            bindable: (workspace.sessionIds || []).length > 0,
            willHeal: status === 'missing-dir' && (workspace.sessionIds || []).length > 0,
          })
        }
        let orphanCount = 0
        try {
          orphanCount = (await listOrphans(200)).length
        } catch {
          orphanCount = -1
        }
        return {
          ok: true,
          autoHeal: settings.autoHeal !== false,
          intervalSeconds: settings.intervalSeconds,
          workspaces: statuses,
          workspaceCount: workspaces.length,
          orphanCount,
        }
      }

      if (action === 'list') {
        const orphans = await listOrphans(args.limit)
        return { ok: true, count: orphans.length, orphans }
      }

      if (action === 'heal') {
        return { ok: true, ...(await healOnce('manual')) }
      }

      if (action === 'preview' || action === 'import') {
        const sessionId = String(args.sessionId || '').trim()
        if (!sessionId) return { ok: false, error: '需要 sessionId' }
        let result
        try {
          result = await digestOf(sessionId, args.maxChars)
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error) }
        }
        if (action === 'preview') {
          return { ok: true, ...result }
        }
        return {
          ok: true,
          sessionId,
          eventCount: result.eventCount,
          body: `【已导入旧会话上下文 · ${sessionId}】\n\n${result.digest}`,
          note: '把 body 原样贴进可见回复即可；旧会话未被修改。',
        }
      }

      return { ok: false, error: `未知 action：${action}` }
  }

  ctx.effect(() => ctx.tools.register(tool))
}
