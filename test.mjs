// 隔离测试：不加载 Harness，只验证纯函数与摘要生成。
import assert from 'node:assert/strict'
import { buildDigest, summarizeEvents, normalizePath, jsonSafe, isInjectedBlock } from './index.js'

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

const user = (text) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const tool = (toolName) => ({ type: 'tool/call', data: { name: toolName, arguments: '{}' } })

const events = [
  { type: 'turn/start', data: { turn: 1 } },
  user('帮我把这个项目跑起来'),
  tool('read'),
  tool('bash'),
  assistant('先看 README，再装依赖。'),
  { type: 'turn/start', data: { turn: 2 } },
  user('报错了，说缺少 flask'),
  tool('bash'),
  assistant('已安装 Flask，服务起来了。'),
  { type: 'turn/start', data: { turn: 3 } },
  user('帮我把端口改成 8080'),
  assistant('已改为 8080。'),
].map((event, index) => ({ ...event, seq: index, time: 1700000000000 + index }))

console.log('workspace-heal 隔离测试')

check('normalizePath 去尾斜杠并统一分隔符', () => {
  const value = normalizePath('D:/deepseek/')
  assert.ok(value.endsWith('deepseek'), value)
  assert.ok(!value.endsWith('\\') && !value.endsWith('/'), value)
})
check('normalizePath 处理空值', () => {
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath(null), '')
  assert.equal(normalizePath(undefined), '')
})

check('summarizeEvents 统计正确', () => {
  const summary = summarizeEvents(events)
  assert.equal(summary.turns, 3)
  assert.equal(summary.userTexts.length, 3)
  assert.equal(summary.assistantTexts.length, 3)
  assert.equal(summary.tools.get('bash'), 2)
  assert.equal(summary.tools.get('read'), 1)
})

check('summarizeEvents 容忍脏数据', () => {
  const summary = summarizeEvents([null, {}, { type: 'user/message' }, { type: 42 }, 'x'])
  assert.equal(summary.turns, 0)
  assert.equal(summary.userTexts.length, 0)
})

check('buildDigest 含目标/最近请求/工具', () => {
  const digest = buildDigest({
    header: { id: 'session-demo', cwd: 'D:\\old-workspace', createdAt: 1700000000000 },
    events,
    maxChars: 4000,
  })
  assert.match(digest, /旧会话上下文/)
  assert.match(digest, /原工作区：D:\\old-workspace/)
  assert.match(digest, /最初目标：帮我把这个项目跑起来/)
  assert.match(digest, /最近的请求/)
  assert.match(digest, /帮我把端口改成 8080/)
  assert.match(digest, /bash×2/)
  assert.match(digest, /旧会话本身未被修改/)
  assert.equal(digest.length <= 4000, true)
})

check('buildDigest 遵守 maxChars 上限', () => {
  const big = Array.from({ length: 60 }, (_, index) => user('很长的需求描述'.repeat(60) + index))
  const digest = buildDigest({ header: { id: 's', cwd: 'D:\\x', createdAt: 1 }, events: big, maxChars: 400 })
  assert.ok(digest.length <= 420, `实际 ${digest.length}`)
  assert.match(digest, /摘要已截断/)
})

check('buildDigest 空会话不崩', () => {
  const digest = buildDigest({ header: { id: 'empty', createdAt: 1 }, events: [] })
  assert.match(digest, /旧会话上下文/)
  assert.match(digest, /0 轮/)
})

check('buildDigest 无 header 也能用', () => {
  const digest = buildDigest({ events, maxChars: 2000 })
  assert.match(digest, /旧会话上下文/)
  assert.ok(!digest.includes('原工作区'))
})

check('jsonSafe 去掉 undefined/NaN，保留结构', () => {
  const clean = jsonSafe({ a: 1, b: undefined, c: NaN, d: 'x', e: { f: undefined, g: [1, undefined, 2] } })
  assert.deepEqual(clean, { a: 1, c: null, d: 'x', e: { g: [1, null, 2] } })
  assert.equal(JSON.stringify(clean), '{"a":1,"c":null,"d":"x","e":{"g":[1,null,2]}}')
})
check('jsonSafe 容忍循环外的函数与 symbol', () => {
  const clean = jsonSafe({ fn: () => 1, sym: Symbol('x'), keep: 'ok' })
  assert.equal(clean.keep, 'ok')
  assert.equal(typeof clean.fn, 'object')
})

check('isInjectedBlock 识别注入块', () => {
  assert.equal(isInjectedBlock('<system-reminder> hi'), true)
  assert.equal(isInjectedBlock('[MNEMON] Search Documents'), true)
  assert.equal(isInjectedBlock('Revision: x\nMNEMON RUNTIME MEMORY SNAPSHOT'), true)
  assert.equal(isInjectedBlock('<runtime-memory-file name="USER.md">'), true)
  assert.equal(isInjectedBlock('Current runtime context. This snapshot supersedes earlier'), true)
  assert.equal(isInjectedBlock('Current DSH file policy: workspace-write.'), true)
  assert.equal(isInjectedBlock('帮我改端口'), false)
  assert.equal(isInjectedBlock(''), false)
})

check('buildDigest 不把运行时注入当成用户请求', () => {
  const mixed = [
    user('帮我把项目跑起来'),
    user('<system-reminder> A skill is a reusable set of task-specific instructions.'),
    user('[MNEMON] Search Documents for substantial project records'),
    user('MNEMON RUNTIME MEMORY SNAPSHOT Revision: abc123 metadata'),
    assistant('好的。'),
  ].map((event, index) => ({ ...event, seq: index, time: 1 }))
  const digest = buildDigest({ header: { id: 's', cwd: 'D:\\x', createdAt: 1 }, events: mixed, maxChars: 2000 })
  assert.match(digest, /帮我把项目跑起来/)
  assert.ok(!digest.includes('system-reminder'), '不应包含 system-reminder')
  assert.ok(!digest.includes('MNEMON'), '不应包含 MNEMON')
  assert.match(digest, /1 条用户消息/)
})

// ---------------------------------------------------------------------------
// 自动重建：注册表用桩，目录写盘走真实文件系统
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { healWorkspaces } from './index.js'

const LAB = path.join(os.tmpdir(), 'dsh-workspace-heal-lab')
const WS = path.join(LAB, 'ws')

function cleanLab() {
  fs.rmSync(LAB, { recursive: true, force: true })
  fs.mkdirSync(LAB, { recursive: true })
}

function stub(entries) {
  return { list: () => entries }
}

console.log('\n自动重建（真实文件系统）')
cleanLab()

const healedResult = await healWorkspaces({
  registry: stub([{ id: 'ws-1', path: WS, sessionIds: ['s1'], status: async () => 'missing-dir' }]),
})
assert.equal(healedResult.healed.length, 1, '应当重建 1 个目录')
assert.equal(fs.existsSync(WS), true, '目录应当真的存在了')
assert.equal(healedResult.healed[0].sessions, 1)
console.log('  ok  缺失目录 + 有会话绑定 → 真的建出来了')
passed += 1

fs.rmSync(WS, { recursive: true, force: true })
const unbound = await healWorkspaces({
  registry: stub([{ id: 'ws-2', path: WS, sessionIds: [], status: async () => 'missing-dir' }]),
})
assert.equal(unbound.healed.length, 0, '无会话绑定不应重建')
assert.equal(fs.existsSync(WS), false, '无会话绑定时目录不应出现')
console.log('  ok  缺失目录 + 无会话绑定 → 不碰')
passed += 1

const healthy = await healWorkspaces({
  registry: stub([{ id: 'ws-3', path: WS, sessionIds: ['s'], status: async () => 'ok' }]),
})
assert.equal(healthy.healed.length, 0)
console.log('  ok  目录正常 → 不动')
passed += 1

const statusBroken = await healWorkspaces({
  registry: stub([
    {
      id: 'ws-4',
      path: WS,
      sessionIds: ['s'],
      status: async () => {
        throw new Error('boom')
      },
    },
  ]),
})
assert.equal(statusBroken.skipped.length, 1)
assert.equal(statusBroken.skipped[0].reason, 'status-error')
console.log('  ok  status() 抛错 → 记 skipped，不崩')
passed += 1

const mkdirFailed = await healWorkspaces({
  registry: stub([{ id: 'ws-5', path: WS, sessionIds: ['s'], status: async () => 'missing-dir' }]),
  mkdir: () => {
    throw new Error('EACCES')
  },
})
assert.equal(mkdirFailed.healed.length, 0)
assert.equal(mkdirFailed.skipped.length, 1)
assert.match(mkdirFailed.skipped[0].reason, /EACCES/)
console.log('  ok  mkdir 失败 → 记 skipped，不崩')
passed += 1

const noRegistry = await healWorkspaces({})
assert.ok(noRegistry.error, '缺少注册表应返回 error')
console.log('  ok  注册表不可用 → 返回 error')
passed += 1

fs.rmSync(LAB, { recursive: true, force: true })
assert.equal(fs.existsSync(LAB), false, '测试目录应清理干净')
console.log('  ok  测试目录已清理')
passed += 1

console.log(`\n全部通过：${passed} 项`)
