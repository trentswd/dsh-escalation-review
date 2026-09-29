#!/usr/bin/env node
/**
 * review-report.mjs —— 把 escalation-review 的评审记录整理成**人可读**的报告
 *
 * 为什么不直接看日志：日志是机器可读的 JSONL（每行一个事件），给人看是折磨。
 * 本工具把「context + 结果」拼成一张表，并写出 Markdown 到 ~/.dsh/escalation-review-report.md。
 *
 * 用法:
 *   node tools/review-report.mjs                    # 默认：渲染插件评审记录（含上下文）
 *   node tools/review-report.mjs --all-approvals    # 扫全部会话，列出你历史上被问过的每一次审批（校准用）
 *   node tools/review-report.mjs --since 23:50      # 只看某个时间之后的评审
 *
 * 上下文来源：插件日志里只有 callId；工具参数的权威来源是会话记录
 * （~/.dsh/sessions/<escaped-ws>/<session-id>/session.v4.jsonl.zstd，多帧 zstd + JSONL）。
 * 本工具按 callId 把两边 join 起来。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LOG_PATH = join(DSH_HOME, 'escalation-review.log')
const REPORT_PATH = join(DSH_HOME, 'escalation-review-report.md')
/** profile 根：配置卡保存的值会写回这里各 profile 的 cordis.patch.yml。 */
const PROFILES_DIR = join(DSH_HOME, 'profiles')

// ───────────────────────────────────────────── 读取助手

function decompressAll(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = 0
  while ((index = buffer.indexOf(MAGIC, index)) >= 0) {
    offsets.push(index)
    index += MAGIC.length
  }
  if (offsets.length <= 1) return zstdDecompressSync(buffer)
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      /* 巧合魔数 */
    }
  }
  return Buffer.concat(parts)
}

function sessionFiles() {
  const root = join(DSH_HOME, 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const workspaceDir of readdirSync(root)) {
    const workspacePath = join(root, workspaceDir)
    if (!statSync(workspacePath).isDirectory()) continue
    for (const sessionDir of readdirSync(workspacePath)) {
      const dir = join(workspacePath, sessionDir)
      if (!statSync(dir).isDirectory()) continue
      for (const file of readdirSync(dir)) {
        if (file.startsWith('session') && file.endsWith('.zstd')) {
          out.push({ workspace: workspaceDir, session: sessionDir, path: join(dir, file) })
        }
      }
    }
  }
  return out
}

function readEvents(path) {
  try {
    const text = decompressAll(readFileSync(path)).toString('utf8')
    const events = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        /* 正在追加的半行 */
      }
    }
    return events
  } catch {
    return []
  }
}

const truncate = (value, limit) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…(+${text.length - limit})`
}

const timeOf = (event) => {
  const ms = Number(event?.time ?? event?.ts ?? 0)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms > 1e12 ? ms : ms * 1000).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 从全部会话里收集 callId → { tool, args } 与审批记录。 */
function collectSessionFacts() {
  const calls = new Map() // callId -> { tool, args }
  const approvals = [] // { asked, decided, tool, reason, callId, workspace }
  for (const entry of sessionFiles()) {
    const events = readEvents(entry.path)
    if (events.length === 0) continue
    const pending = new Map()
    for (const event of events) {
      const data = event?.data ?? {}
      if (event.type === 'tool/call') {
        const id = data.callId ?? data.id ?? data.rootCallId
        if (id !== undefined && !calls.has(id)) calls.set(String(id), { tool: data.name, args: data.arguments, workspace: entry.workspace })
      }
      if (event.type === 'approval/asked') {
        const key = String(data.id ?? data.callId ?? approvals.length)
        pending.set(key, { at: timeOf(event), tool: data.toolName, reason: data.reason, callId: data.callId, workspace: entry.workspace })
      }
      if (event.type === 'approval/decided') {
        const key = String(data.id ?? data.callId ?? '')
        const asked = pending.get(key) ?? { at: '', tool: data.toolName, reason: data.reason, callId: data.callId, workspace: entry.workspace }
        approvals.push({ ...asked, outcome: data.outcome })
        pending.delete(key)
      }
    }
    for (const asked of pending.values()) approvals.push({ ...asked, outcome: '(无结果记录)' })
  }
  return { calls, approvals }
}

/**
 * 找出插件自带的 config.json。UI「添加插件」装的是 `link:` 依赖（软链到源码目录），
 * 所以不能只找 profiles/node_modules —— 要顺着各 profile 的 package.json 解析真实目录。
 */
function pluginConfigCandidates() {
  const profilesDir = join(DSH_HOME, 'profiles')
  const out = []
  for (const dir of existsSync(profilesDir) ? readdirSync(profilesDir) : []) {
    const manifest = join(profilesDir, dir, 'package.json')
    let parsed
    if (existsSync(manifest)) {
      try {
        parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      } catch {
        parsed = undefined
      }
    }
    for (const [name, spec] of Object.entries(parsed?.dependencies ?? {})) {
      if (name === 'dsh-escalation-review' && typeof spec === 'string' && /^(link|file):/.test(spec)) {
        out.push(join(spec.replace(/^(link|file):/, ''), 'config.json'))
      }
    }
    out.push(join(profilesDir, dir, 'node_modules', 'dsh-escalation-review', 'config.json'))
  }
  out.push(join(profilesDir, 'node_modules', 'dsh-escalation-review', 'config.json'))
  return out
}

/**
 * 读取"设置层"：配置卡保存的值由 settings 服务写回 profile 的 cordis.patch.yml，
 * 即 \`- id: escalation-review\` 条目的 \`config:\` 块 —— 这一层**高于**文件层。
 * 只做极简 YAML 解析（settings 写出的形状很规整），不为此引入 yaml 依赖。
 */
function readSettingsLayer() {
  const dirs = existsSync(PROFILES_DIR) ? readdirSync(PROFILES_DIR, { withFileTypes: true }) : []
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const patch = join(PROFILES_DIR, entry.name, 'cordis.patch.yml')
    if (!existsSync(patch)) continue
    let lines
    try {
      lines = readFileSync(patch, 'utf8').split('\n')
    } catch {
      continue
    }
    const start = lines.findIndex((line) => /^-\s+id:\s*escalation-review\s*$/.test(line))
    if (start < 0) continue
    const config = {}
    let inConfig = false
    let configIndent = 0
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^-\s+id:/.test(line)) break
      if (line.trim() === '') continue
      const indent = line.match(/^ */)[0].length
      const body = line.trim()
      if (!inConfig) {
        if (body === 'config:') {
          inConfig = true
          configIndent = indent
        }
        continue
      }
      if (indent <= configIndent) break
      const m = body.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/)
      if (!m) continue
      let value = m[2].trim()
      if (value.startsWith("'") || value.startsWith('"')) {
        const quote = value[0]
        const end = value.indexOf(quote, 1)
        value = end > 0 ? value.slice(1, end) : value.slice(1)
      } else {
        const hash = value.indexOf(' #')
        if (hash >= 0) value = value.slice(0, hash).trim()
      }
      config[m[1]] = value
    }
    if (Object.keys(config).length > 0) return { file: patch, config }
  }
  return undefined
}

/** 实时算出生效配置（不依赖插件模块，自己按同样优先级合并）。 */
function readEffectiveConfig() {
  const userConfig = join(DSH_HOME, 'escalation-review.config.json')
  const candidates = [...new Set([...pluginConfigCandidates(), userConfig])]
  const strip = (text) => {
    let out = ''
    let inString = false
    let escaped = false
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        out += ch
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        out += ch
        continue
      }
      if (ch === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i += 1
        out += '\n'
        continue
      }
      out += ch
    }
    return out
  }
  const merged = { mode: 'observe', allowedHosts: [], policyExtra: '' }
  const files = []
  const errors = []
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(strip(readFileSync(file, 'utf8')))
      if (typeof parsed.mode === 'string') merged.mode = parsed.mode
      if (Array.isArray(parsed.allowedHosts)) merged.allowedHosts = parsed.allowedHosts
      if (typeof parsed.policyExtra === 'string') merged.policyExtra = parsed.policyExtra
      files.push(file)
    } catch (error) {
      errors.push(`${file}: ${String(error?.message ?? error)}`)
    }
  }
  // 设置层（配置卡）优先级最高：它写回 profile 的 cordis.patch.yml
  const settings = readSettingsLayer()
  if (settings !== undefined) {
    const c = settings.config
    if (typeof c.mode === 'string' && c.mode.length > 0) merged.mode = c.mode
    if (typeof c.policyExtra === 'string') merged.policyExtra = c.policyExtra
  }
  return {
    mode: merged.mode,
    hosts: merged.allowedHosts,
    policyExtraLength: merged.policyExtra.length,
    files,
    errors,
    settings,
  }
}

// ───────────────────────────────────────────── 视图：插件评审

function pluginView(since) {
  if (!existsSync(LOG_PATH)) return `（还没有评审日志：${LOG_PATH}）\n`
  const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter((l) => l.length > 0)
  const entries = []
  let bad = 0
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line))
    } catch {
      bad += 1
    }
  }
  const reviewed = entries.filter((e) => e.event === 'reviewed' || e.event === 'reviewer-failed')
  const filtered = since === undefined ? reviewed : reviewed.filter((e) => (e.ts ?? '').slice(11, 16) >= since)

  const { calls } = collectSessionFacts()
  const out = []
  out.push('# escalation-review 评审报告')
  out.push('')
  out.push(`- 日志：\`${LOG_PATH}\``)
  out.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`)
  out.push(`- 事件总数：${entries.length}${bad > 0 ? `（有 ${bad} 行解析失败）` : ''}`)

  const startup = entries.filter((e) => ['module-imported', 'apply-called', 'ready'].includes(e.event))
  const ready = entries.filter((e) => e.event === 'ready').pop()
  const latestPid = entries.filter((e) => e.event === 'module-imported').pop()?.pid
  const currentTraces = latestPid === undefined ? startup : startup.filter((e) => e.pid === latestPid)
  const applyCalls = currentTraces.filter((e) => e.event === 'apply-called').length

  // 实时计算生效配置（ready 那行是启动时的快照，可能已经过期）
  const effective = readEffectiveConfig()
  out.push('')
  out.push('## 加载状态')
  out.push('')
  if (ready !== undefined) {
    out.push(`- 启动时模式：**${ready.mode}**${ready.mode === 'observe' ? '（只评审记录、不干预）' : '（按评审结果放行/拒绝）'}`)
    out.push(`- 失败处理：failMode=\`${ready.failMode}\`，denyMode=\`${ready.denyMode}\`，超时 ${ready.timeoutMs}ms`)
  } else {
    out.push('- 未见 `ready`：插件没有完成加载（检查 patch YAML 与 profile bundles）')
  }
  if (effective.settings !== undefined) {
    const c = effective.settings.config
    const parts = []
    if (typeof c.mode === 'string') parts.push('mode=' + c.mode)
    if (typeof c.reasoningEffort === 'string' && c.reasoningEffort.length > 0) parts.push('思考强度=' + c.reasoningEffort)
    if (typeof c.provider === 'string' && c.provider.length > 0) parts.push('provider=' + c.provider)
    if (typeof c.model === 'string' && c.model.length > 0) parts.push('model=' + c.model)
    if (typeof c.timeoutMs === 'string' && c.timeoutMs.length > 0) parts.push('超时=' + c.timeoutMs + 'ms')
    out.push('- **当前生效配置（设置层 = 配置卡，优先于文件层）**：' + (parts.length > 0 ? parts.join('，') : '(未覆盖任何字段)'))
    out.push('- 设置层文件：' + '\`' + effective.settings.file + '\`')
  } else {
    out.push('- **当前生效配置（设置层 = 配置卡）**：(这个 profile 里没有该条目的 config 覆盖，沿用文件层)')
  }
  out.push('- 文件层（仅作对照，可能被上面覆盖）：mode=' + effective.mode + '，白名单主机 ' + effective.hosts.length + ' 个，policyExtra ' + (effective.policyExtraLength > 0 ? '有 ' + effective.policyExtraLength + ' 字' : '为空'))
  out.push(`- 生效配置文件：${effective.files.map((f) => `\`${f}\``).join('、') || '(无)'}${effective.errors.length > 0 ? ` ⚠️ ${effective.errors.join('；')}` : ''}`)
  out.push(`- 当前进程（pid ${latestPid ?? '?'}）加载痕迹：${currentTraces.map((e) => e.event).join(' → ') || '(无)'}`)
  // 更可靠的"现在有几份实例"判据：最近一次越界被评审了几次
  const counts = new Map()
  for (const entry of reviewed) {
    const key = String(entry.callId ?? '')
    if (key.length > 0) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const latestCall = [...counts.entries()].pop()
  if (latestCall !== undefined) {
    out.push(`- **当前实例数判据**：最近一次越界（${latestCall[0].slice(0, 24)}…）被评审 **${latestCall[1]} 次** → ${latestCall[1] === 1 ? '正常（单实例）' : `⚠️ 多实例（每次越界会被评审 ${latestCall[1]} 次）`}`)
  }
  const loads = entries.filter((e) => e.event === 'module-imported').length
  const applies = entries.filter((e) => e.event === 'apply-called').length
  out.push(`- 累计加载 ${loads} 次 / apply ${applies} 次（每次启动或热重载各记一次；判定当前实例数只看上一行）`)

  out.push('')
  out.push('## 评审记录')
  out.push('')
  if (filtered.length === 0) {
    out.push('（还没有评审过任何越界调用）')
    return `${out.join('\n')}\n`
  }

  const byRisk = {}
  const byDecision = {}
  let totalMs = 0
  let maxMs = 0
  for (const entry of filtered) {
    byRisk[entry.risk ?? '?'] = (byRisk[entry.risk ?? '?'] ?? 0) + 1
    byDecision[entry.decision ?? '失败'] = (byDecision[entry.decision ?? '失败'] ?? 0) + 1
    totalMs += Number(entry.ms ?? 0)
    maxMs = Math.max(maxMs, Number(entry.ms ?? 0))
  }
  out.push(`- 共 ${filtered.length} 次评审：${Object.entries(byDecision).map(([k, v]) => `${k}×${v}`).join('，')}`)
  out.push(`- 风险分布：${Object.entries(byRisk).map(([k, v]) => `${k}×${v}`).join('，')}`)
  out.push(`- 耗时：平均 ${Math.round(totalMs / filtered.length)}ms，最长 ${maxMs}ms`)

  const seen = new Set()
  let index = 0
  for (const entry of filtered) {
    index += 1
    const callId = String(entry.callId ?? '')
    const call = calls.get(callId)
    const verdict = entry.event === 'reviewer-failed' ? '**评审失败 → 已按策略拒绝**' : `**${entry.decision}** / ${entry.risk}`
    out.push('')
    out.push(`### ${index}. ${(entry.ts ?? '').slice(11, 19)} — ${entry.tool ?? '?'} — ${verdict}（${entry.ms ?? '?'}ms）`)
    out.push('')
    out.push(`- 请求模式：\`${entry.requested ?? '?'}\` → 生效模式：\`${entry.effective ?? '未知'}\``)
    if (call !== undefined) {
      let args = call.args
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          /* 保留原字符串 */
        }
      }
      if (typeof args === 'object' && args !== null) {
        const body = args.command ?? args.script ?? args.arguments ?? args
        out.push('- 动作：')
        out.push('  ```')
        for (const line of String(typeof body === 'string' ? body : JSON.stringify(body, null, 2)).split('\n').slice(0, 14)) {
          out.push(`  ${line}`)
        }
        out.push('  ```')
        if (args.description !== undefined) out.push(`- 动作说明：${truncate(args.description, 200)}`)
        if (args.justification !== undefined) out.push(`- agent 写的理由：${truncate(args.justification, 300)}`)
      } else {
        out.push(`- 动作：\`${truncate(args, 300)}\``)
      }
    } else {
      out.push('- 动作：(会话里没找到该 callId 的参数记录)')
    }
    if (entry.reason !== undefined) out.push(`- reviewer 给的理由：${entry.reason}`)
    if (entry.event === 'reviewer-failed' && entry.message !== undefined) out.push(`- 失败详情：${entry.message}`)
    if (callId.length > 0 && !seen.has(callId)) seen.add(callId)
  }
  out.push('')
  out.push(`涉及 ${seen.size} 个不同的调用（每个调用的评审次数应为 1；多于 1 说明插件注册了多份实例）。`)

  // 策略自检：伪造动作的判定（未执行任何工具）
  const selfTests = entries.filter((e) => e.event === 'selftest')
  if (selfTests.length > 0) {
    const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
    out.push('')
    out.push('## 策略自检（伪造动作，未执行任何工具）')
    out.push('')
    out.push('| 伪造动作 | 上下文 | 期望 | 实际 | 一致 | 风险 | reviewer 的理由 |')
    out.push('|---|---|---|---|---|---|---|')
    for (const test of selfTests.slice(-12)) {
      const reason = test.reason ?? test.message ?? (test.decision === 'allow' ? '（allow 按协议不带理由）' : '')
      out.push(
        `| \`${cell(truncate(test.command ?? test.case, 70))}\` | ${cell(test.context ?? '')} | ${cell(test.expect)} | ${cell(
          test.decision,
        )} | ${test.pass === true ? '✅' : '❌'} | ${cell(test.risk)} | ${cell(truncate(reason, 140))} |`,
      )
    }
    const summary = entries.filter((e) => e.event === 'selftest-summary').pop()
    if (summary !== undefined) {
      out.push('')
      out.push(`合计 ${summary.total} 条，通过 ${summary.passed}；未通过：${(summary.failed ?? []).join('、') || '无'}`)
    }
  }
  return `${out.join('\n')}\n`
}

// ───────────────────────────────────────────── 视图：历史审批（校准用）

function approvalsView(since) {
  const { approvals } = collectSessionFacts()
  const filtered = since === undefined ? approvals : approvals.filter((a) => a.at >= since)
  const out = []
  out.push('# DSH 历史审批清单（跨全部会话）')
  out.push('')
  out.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`)
  out.push(`- 共 ${filtered.length} 次审批请求`)
  const byOutcome = {}
  const byTool = {}
  for (const a of filtered) {
    byOutcome[a.outcome ?? '?'] = (byOutcome[a.outcome ?? '?'] ?? 0) + 1
    byTool[a.tool ?? '?'] = (byTool[a.tool ?? '?'] ?? 0) + 1
  }
  out.push(`- 结果分布：${Object.entries(byOutcome).map(([k, v]) => `${k}×${v}`).join('，')}`)
  out.push(`- 工具分布：${Object.entries(byTool).map(([k, v]) => `${k}×${v}`).join('，')}`)
  out.push('')
  out.push('| 时间 | 工具 | 提问理由（agent 视角） | 结果 | 工作区 |')
  out.push('|---|---|---|---|---|')
  for (const a of filtered) {
    out.push(`| ${a.at} | ${a.tool ?? '?'} | ${truncate(a.reason ?? '', 120)} | ${a.outcome ?? '?'} | ${String(a.workspace ?? '').replace(/^--|--$/g, '').slice(0, 40)} |`)
  }
  return `${out.join('\n')}\n`
}

// ───────────────────────────────────────────── 入口

const args = process.argv.slice(2)
const sinceIndex = args.indexOf('--since')
const since = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined
const mode = args.includes('--all-approvals') ? 'approvals' : 'plugin'
const report = mode === 'approvals' ? approvalsView(since) : pluginView(since)

console.log(report)
// 首选写到 $DSH_HOME；沙箱内写不进去时退回到插件目录旁的副本（工作区内，随时可打开）
const fallback = join(fileURLToPath(new URL('..', import.meta.url)), 'review-report.md')
for (const target of [REPORT_PATH, fallback]) {
  try {
    writeFileSync(target, report, 'utf8')
    console.log(`\n（已写出 Markdown：${target}）`)
    break
  } catch (error) {
    console.log(`\n（写出失败 ${target}：${String(error?.message ?? error)}）`)
  }
}
