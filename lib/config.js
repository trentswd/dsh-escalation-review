/**
 * config.js —— 配置控制面（与插件入口解耦，可单独阅读与单测）
 *
 * 优先级（低 → 高）：
 *   1) 插件目录 config.json   2) $DSH_HOME/escalation-review.config.json
 *   3) 显式 configPath        4) 宿主 config（apply 的第二参）
 * 另有第 5 层在 index.js 里：Host 设置的 **user 覆盖层**（配置页保存的那层，每 2 秒重读 → 免重启生效）。
 *
 * 之所以把 BOOT_LOG / 默认值放这里：它们与"配置从哪来、落到哪"是同一件事，
 * 而 index.js 只关心控制流（钩子接线）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 100_000
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 5_000
const DEFAULT_MIN_ATTEMPT_MS = 2_000
const DEFAULT_HISTORY_LIMIT = 12
const DEFAULT_TRANSCRIPT_LIMIT = 40
const DEFAULT_TEXT_LIMIT = 900
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_LOG_NAME = 'dsh-escalation-review.log'

/** 诊断日志：落在 $DSH_HOME（不依赖可能被重定向/删掉的 TMP）。 */
const BOOT_LOG = (() => {
  try {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    return join(home, 'escalation-review.log')
  } catch {
    return join(tmpdir(), DEFAULT_LOG_NAME)
  }
})()

// ─────────────────────────────────────────────────────────────── 配置（控制面）


/** 标准思考强度档位（模型不支持某档时由 provider 决定，评审失败即按 failMode 处理）。 */
export const REASONING_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export const DEFAULT_CONFIG = {
  devMode: false, // 开发者模式：配置页显示调试项（运行模式 / 策略自检）
  enabled: false, // 介入开关：true 时接管**所有**沙箱越界的审批（与权限预设、profile 完全解耦）
  enabledText: '', // GUI 表单用（'true'/'false' 文本）；非空时覆盖 enabled
  mode: 'enforce', // observe | enforce（随包默认 enforce：开关打开后按评审结果放行/拒绝）
  selfTest: false, // true：第一次越界后用**伪造动作**跑一遍策略自测（绝不执行工具）
  selfTestText: '', // GUI 表单用（文本）；非空时覆盖 selfTest（'true'/'false'）
  selftestModule: '', // 可选：附加自测模块的绝对路径（留空则按装载器的默认来源查找）
  timeoutMs: DEFAULT_TIMEOUT_MS,
  attemptTimeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS, // 单次尝试上限
  retryDelayMs: DEFAULT_RETRY_DELAY_MS, // 两次尝试之间的等待
  minAttemptMs: DEFAULT_MIN_ATTEMPT_MS, // 剩余预算低于此值就不再重试
  reasoningEffort: '', // 评审调用的思考强度：''＝跟随会话/模型默认；否则 off|minimal|low|medium|high|xhigh|max
  failMode: 'deny', // 评审失败/超时：deny | ask
  denyMode: 'deny', // 政策拒绝：deny | ask（ask 时交回人工，对齐 Codex 非 strict 档）
    probeRunner: 'inproc', // 只读探针执行方式：inproc=进程内（默认，不 spawn）| shell=沙箱内只读命令
  provider: '',
  model: '',
  allowedHosts: [],
  allowedHostsText: '', // GUI 表单用（逗号/换行分隔）；非空时覆盖 allowedHosts
  policyExtra: '',
  logPath: '',
  historyLimit: DEFAULT_HISTORY_LIMIT,
  transcriptLimit: DEFAULT_TRANSCRIPT_LIMIT,
  textLimit: DEFAULT_TEXT_LIMIT,
}

/** 容忍 `//` 与块注释的 JSON 解析（字符串内的注释符不误伤）。 */
export function parseConfigText(text) {
  const source = String(text)
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
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
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  const value = JSON.parse(out)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be a JSON object')
  }
  return value
}

function sanitize(patch) {
  const out = {}
  if (patch === null || typeof patch !== 'object') return out
  if (patch.mode === 'observe' || patch.mode === 'enforce') out.mode = patch.mode
  // 思考强度：只接受标准档位 id（'' 表示跟随会话/模型默认）
  if (typeof patch.reasoningEffort === 'string') {
    const effort = patch.reasoningEffort.trim()
    if (effort === '' || REASONING_EFFORTS.has(effort)) out.reasoningEffort = effort
  }
  if (patch.failMode === 'deny' || patch.failMode === 'ask') out.failMode = patch.failMode
  if (patch.denyMode === 'deny' || patch.denyMode === 'ask') out.denyMode = patch.denyMode
    if (patch.probeRunner === 'inproc' || patch.probeRunner === 'shell') out.probeRunner = patch.probeRunner
  if (typeof patch.selftestModule === 'string' && patch.selftestModule.trim().length > 0) out.selftestModule = patch.selftestModule.trim()
  if (typeof patch.selfTest === 'boolean') out.selfTest = patch.selfTest
  if (Number.isFinite(patch.timeoutMs) && patch.timeoutMs >= 1000) out.timeoutMs = Math.min(Math.floor(patch.timeoutMs), 300_000)
  if (Number.isFinite(patch.attemptTimeoutMs) && patch.attemptTimeoutMs >= 1000) out.attemptTimeoutMs = Math.min(Math.floor(patch.attemptTimeoutMs), 300_000)
  if (Number.isFinite(patch.retryDelayMs) && patch.retryDelayMs >= 0) out.retryDelayMs = Math.min(Math.floor(patch.retryDelayMs), 60_000)
  if (Number.isFinite(patch.minAttemptMs) && patch.minAttemptMs >= 0) out.minAttemptMs = Math.min(Math.floor(patch.minAttemptMs), 60_000)
  for (const key of ['provider', 'model', 'policyExtra', 'logPath', 'configPath']) {
    if (typeof patch[key] === 'string') out[key] = patch[key]
  }
  if (Array.isArray(patch.allowedHosts)) {
    out.allowedHosts = patch.allowedHosts.filter((h) => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim())
  }
  for (const key of ['historyLimit', 'transcriptLimit', 'textLimit']) {
    if (Number.isFinite(patch[key]) && patch[key] > 0) out[key] = Math.floor(patch[key])
  }

  // GUI 表单（设置页）用的是**文本字段**：官方的 SettingsFormModel 只带 settingsTextField /
  // settingsNumberField 两种控件，所以布尔/数组以文本暴露，在这里解析成规范值。
  if (typeof patch.selfTestText === 'string' && patch.selfTestText.trim().length > 0) {
    out.selfTestText = patch.selfTestText.trim()
    out.selfTest = /^(true|1|yes|on|开|是)$/i.test(out.selfTestText)
  }
  if (typeof patch.devMode === 'boolean') out.devMode = patch.devMode
  if (typeof patch.devModeText === 'string' && patch.devModeText.trim().length > 0) out.devMode = /^(true|1|yes|on|开|是)$/i.test(patch.devModeText.trim())
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled
  if (typeof patch.enabledText === 'string' && patch.enabledText.trim().length > 0) {
    out.enabledText = patch.enabledText.trim()
    out.enabled = /^(true|1|yes|on|开|是)$/i.test(out.enabledText)
  }
  if (typeof patch.allowedHostsText === 'string' && patch.allowedHostsText.trim().length > 0) {
    out.allowedHostsText = patch.allowedHostsText.trim()
    out.allowedHosts = out.allowedHostsText
      .split(/[,\n;]/)
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
  }
  return out
}

/**
 * 解析生效配置。优先级（低 → 高）：
 *   1) 插件目录 config.json   2) $DSH_HOME/escalation-review.config.json   3) 显式 configPath   4) 宿主 config
 */
export function resolveConfig(options = {}) {
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const candidates = [
    join(PACKAGE_DIR, 'config.json'),
    join(dshHome, 'escalation-review.config.json'),
    // GUI 配置卡写出来的用户覆盖（由根平面的伴生 entry lib/settings-bridge.js 维护）→ 文件层里优先级最高
    join(dshHome, 'escalation-review.ui.json'),
  ]
  if (typeof options.configPath === 'string' && options.configPath.length > 0) candidates.push(options.configPath)

  let merged = { ...DEFAULT_CONFIG }
  const loaded = []
  const errors = []
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      merged = { ...merged, ...sanitize(parseConfigText(readFileSync(file, 'utf8'))) }
      loaded.push(file)
    } catch (error) {
      errors.push(`${file}: ${String(error?.message ?? error)}`)
    }
  }
  merged = { ...merged, ...sanitize(options) }
  merged.loadedConfigFiles = loaded
  merged.configErrors = errors
  merged.logPath = merged.logPath.length > 0 ? merged.logPath : BOOT_LOG
  return merged
}

// index.js 需要这些常量（实现仍是本模块私有，这里只是显式再导出）
export {
  BOOT_LOG,
  sanitize,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_TEXT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MIN_ATTEMPT_MS,
  DEFAULT_TRANSCRIPT_LIMIT,
  PACKAGE_DIR,
}