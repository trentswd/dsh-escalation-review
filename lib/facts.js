/**
 * facts.js —— 从**动作参数**里做纯文本的路径候选解析（评审路径策略的输入）
 *
 * 2026-09-30 起本模块的定位收窄为**纯解析**（改动前先读）：
 *   · 只把待审动作的参数文本变成带**来源标注**的候选路径（`field:*` 结构化字段 / `text:*` 自由文本）；
 *   · **不 import `node:fs`**：不 lstat、不 readdir、不读内容。原先那层"宿主本地事实"
 *     （`collectLocalFacts` / `factFor` / `gitRootOf`）有权限成本、没有功能收益
 *     （`selectProbes` 根本没用它的内容），而且与"评审器的观察必须经宿主沙箱通道"这条铁律相冲突 —— 已整体删除。
 *     要读文件/目录的 metadata 或内容，一律走 `verify.js` 的只读工具（沙箱通道 + 路径策略）。
 *
 * 为什么保留候选而**不剪枝**：`Copy-Item 'D:\proj' 'D:\proj\backup'` 里 `D:\proj` 是另一个候选的
 * 前缀，但它自己是真实目标 —— 丢掉就是静默丢证据。所以全部保留，只打两个标：
 *   · source：`field:<键名>`（结构化字段，可信）或 `text:<键名>`（命令/散文正文，可能是碎片）
 *   · likelyFragmentOf：它是某个更长候选的前缀，或是挂在 Windows 路径上的 POSIX 尾巴
 *
 * ⚠️ **权限规则**（`verify.js` 依赖它，别改坏）：**自由文本能提供证据，不能提供能力** ——
 *    只有 `field:*`（结构化路径字段）与 `text:command`（命令正文）能进"动作路径"白名单；
 *    `text:justification` / `text:description` 等散文**永远不能**扩大读取权限。
 */

const MAX_PATHS = 12

/** 像路径吗？（宽进严出：先归一化，再要求真实路径形状，并排除散文） */
const FULL_WIDTH_PUNCT = /[，。；：！？、（）【】“”]/
const PATH_SHAPE = /^~?[\\/]|^[A-Za-z]:[\\/]|^\.{1,2}[\\/]|^\\\\[^\\\s]|^\/(?:[\w.$-]+\/)+[\w.$-]+$/
function looksLikePath(raw) {
  const candidate = String(raw).trim().replace(/\\\\/g, '\\').replace(/[\\/]+$/, '')
  if (candidate.length < 3 || candidate.length > 260) return undefined
  if (candidate.includes('\u0000')) return undefined
  if (FULL_WIDTH_PUNCT.test(candidate)) return undefined
  if (!PATH_SHAPE.test(candidate)) return undefined
  return candidate
}

/**
 * 从待审参数里挑出候选路径，**并标注来源与疑似碎片**（绝不丢弃）。
 *
 * 为什么不剪枝：`Copy-Item 'D:\proj' 'D:\proj\backup'` 里 `D:\proj` 是另一个候选的**前缀**，
 * 但它自己是真实目标 —— 丢掉就是静默丢证据。所以保留全部候选，只打两个标：
 *   · source：`field:<键名>`（结构化字段，可信）或 `text`（命令/散文正文，可能是碎片）
 *   · likelyFragmentOf：它是某个更长候选的前缀，或是挂在 Windows 路径上的 POSIX 尾巴
 */
export function extractCandidates(args) {
  const found = []
  const seen = new Map()
  const push = (raw, source) => {
    const trimmed = String(raw).replace(/[\\/]+$/, '')
    if (trimmed.length < 3) return
    const key = trimmed.toLowerCase()
    const existing = seen.get(key)
    if (existing !== undefined) {
      if (String(source).startsWith('field:')) existing.source = source
      return
    }
    const record = { path: trimmed, source }
    seen.set(key, record)
    found.push(record)
  }
  const walk = (value, depth, source) => {
    if (depth > 4 || found.length >= MAX_PATHS * 3) return
    if (typeof value === 'string') {
      // 先把 URL 整体剥掉：否则 `https://example.com/a/b` 会被当成路径 /example.com/a/b
      const cleaned = value.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
      // ① 整个字符串就是路径（write/read 类工具的 file_path）——最常见、最可信
      const whole = looksLikePath(value)
      if (whole !== undefined) {
        push(whole, source)
        return
      }
      // ② 引号里的整段路径（含空格时只能这样拿全，按空白切会截断成假路径）
      for (const quoted of cleaned.matchAll(/"([^"]{3,260})"|'([^']{3,260})'/g)) {
        const candidate = looksLikePath(quoted[1] ?? quoted[2])
        if (candidate !== undefined) push(candidate, source)
        if (found.length >= MAX_PATHS * 3) return
      }
      // ③ 裸路径。碎片要在**源头**不产生，而不是产生后再剪：
      //    · POSIX 形式必须落在**词边界**，否则会把 Windows 路径里的 `.../dsh/node_modules`
      //      当成独立路径（碎片的主要来源）
      //    · Windows 形式允许"空格续写"（DeepSeek Harness\resources），但 40 字符内必须再出现分隔符
      //    · 字符集含 `~ @ % + . _ -`，不含 shell 元字符
      const boundary = '(?:^|[\\s"\'=:(,])'
      const barePath = new RegExp(
        '[A-Za-z]:[\\\\/][^"\'\\s|;<>()]*[ ][^"\'\\s|;<>()]{1,40}[\\\\/][^"\'\\s|;<>()]+' +
          '|[A-Za-z]:[\\\\/][^"\'\\s|;<>()]+' +
          '|' + boundary + '~?/[\\w.@%+-]+(?:/[\\w.@%+-]+)+' +
          '|' + boundary + '\\.{1,2}/[\\w./-]+',
        'g',
      )
      for (const match of cleaned.matchAll(barePath)) {
        const raw = match[0].replace(/^[\s"'=:(,]/, '')
        const candidate = looksLikePath(raw)
        if (candidate === undefined) continue
        push(candidate, source)
        if (found.length >= MAX_PATHS * 3) return
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, source)
      return
    }
    if (value !== null && typeof value === 'object') {
      // 只有**结构化路径字段**才算可信来源；command / description / justification 都是自由文本
      const STRUCTURED = /^(file_path|filePath|path|paths|target|cwd|dir|directory|dest|destination|source|to|from)$/i
      for (const [key, item] of Object.entries(value)) {
        walk(item, depth + 1, STRUCTURED.test(key) ? 'field:' + key : 'text:' + key)
      }
    }
  }
  walk(args, 0, 'text')
  // 标注疑似碎片（**保留，不删**）：比较的是完整候选集，所以与扫描顺序无关
  const normalize = (p) => p.replace(/\//g, '\\').toLowerCase()
  for (const record of found) {
    const lower = record.path.toLowerCase()
    const parent = found.find((other) => {
      if (other === record) return false
      const otherLower = other.path.toLowerCase()
      if (otherLower.length > lower.length && otherLower.startsWith(lower)) return true
      if (record.path.startsWith('/') && normalize(other.path).endsWith(normalize(record.path))) return true
      return false
    })
    if (parent !== undefined) record.likelyFragmentOf = parent.path
  }
  return found.slice(0, MAX_PATHS)
}

/** 兼容旧调用：只取路径字符串。 */
export function extractCandidatePaths(args) {
  return extractCandidates(args).map((record) => record.path)
}

/**
 * 按**来源可信度**分级取动作路径（`verify.js` 的读取白名单只接受这两类）：
 *   · trusted —— `field:*`：结构化路径字段（`file_path` / `target` / `destination` …），可信；
 *   · command —— `text:command`：命令正文里的路径，较弱但仍是"动作本身涉及"的路径；
 *   · 其余（`text:justification` / `text:description` / 顶层裸字符串等）**一律丢弃** ——
 *     自由文本可以提供证据，不能提供能力。
 */
export function extractActionPaths(args) {
  const trusted = []
  const command = []
  for (const record of extractCandidates(args)) {
    const source = String(record?.source ?? '')
    if (source.startsWith('field:')) trusted.push(record.path)
    else if (source === 'text:command') command.push(record.path)
  }
  return { trusted, command }
}
