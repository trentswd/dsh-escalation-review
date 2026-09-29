/**
 * facts.js —— 宿主侧确定性事实（评审的"只读核实"层，第一层）
 *
 * 为什么先做这一层，而不是让评审器自己跑命令：
 *   · Codex 的 guardian 能跑**只读**命令核实（例如批准删除前先看目标），但它的工具集是受限的，
 *     不是任意 exec —— 让模型自己拼命令等于开一个注入面。
 *   · 而我们最需要的那些事实（目标是否存在、是文件还是目录、多大、是不是空目录、是否在工作区内、
 *     git 仓库边界）在进程内用 `fs` 就能拿到，比解析命令输出更可靠：无引号/编码/本地化差异。
 *
 * 边界（刻意的）：
 *   · 只做 metadata，**不读文件内容**（内容属于证据，会进 prompt；先不做，避免把隐私塞进模型）
 *   · 全程 try（任何失败记 note，绝不抛）；路径数量与目录扫描都有上限
 *   · 这些事实标注为"宿主核实的当前状态"，与不可信的 transcript 明确分开
 */
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const MAX_PATHS = 12
const MAX_DIR_ENTRIES = 50
// 有界内容预览（对应 Codex「批准删除/写入前先看内容」）：先看大小再读，只读前若干字节
const PREVIEW_MAX_FILE_BYTES = 4_096
const PREVIEW_BYTES = 512
const MAX_PREVIEWS = 2

/** 路径是否在某个根目录内（考虑 Windows 大小写与分隔符）。 */
function isInside(root, target) {
  if (typeof root !== 'string' || root.length === 0) return undefined
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  if (rootPath === targetPath) return true
  const rel = relative(rootPath, targetPath)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

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

/** 找到某个路径所属的 git 仓库根（向上找 .git，最多 6 层）。 */
function gitRootOf(target) {
  let current = resolve(target)
  for (let i = 0; i < 6 && current.length > 3; i += 1) {
    try {
      if (existsSync(join(current, '.git'))) return current
    } catch {
      return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** 单个路径的事实（永不抛）。 */
export function factFor(rawPath, cwd) {
  const fact = { path: rawPath }
  try {
    // `~` 要展开成 home：否则会解析到 `<cwd>/~/.dsh/...`，报出假的 exists=false
    const expanded = rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\')
      ? join(homedir(), rawPath.slice(2))
      : rawPath
    const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd ?? '.', expanded)
    fact.resolved = absolute
    const inside = isInside(cwd, absolute)
    if (inside !== undefined) fact.insideWorkspace = inside
    let stats
    try {
      stats = lstatSync(absolute)
    } catch {
      stats = undefined
    }
    if (stats === undefined) {
      fact.exists = false
      return fact
    }
    fact.exists = true
    fact.kind = stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file'
    fact.bytes = stats.size
    fact.modifiedAt = new Date(stats.mtimeMs).toISOString()
    if (fact.kind === 'directory') {
      let entries
      try {
        entries = readdirSync(absolute)
      } catch {
        entries = undefined
      }
      if (entries !== undefined) {
        fact.entries = entries.length
        fact.empty = entries.length === 0
        if (entries.length > 0 && entries.length <= MAX_DIR_ENTRIES) fact.sampleEntries = entries.slice(0, 8)
      }
    }
    if (fact.kind === 'file' && stats.size > 0 && stats.size <= PREVIEW_MAX_FILE_BYTES) {
      // 只在小文件上读前 512 字节；出现 NUL 视为二进制，直接不给预览（不读、不猜）
      try {
        const fd = openSync(absolute, 'r')
        try {
          const buffer = Buffer.alloc(PREVIEW_BYTES)
          const read = readSync(fd, buffer, 0, PREVIEW_BYTES, 0)
          const slice = buffer.subarray(0, read)
          if (!slice.includes(0)) fact.preview = slice.toString('utf8').slice(0, PREVIEW_BYTES)
        } finally {
          closeSync(fd)
        }
      } catch {
        /* 读不到就不给预览，绝不影响其它事实 */
      }
    }
    const gitRoot = gitRootOf(absolute)
    if (gitRoot !== undefined) fact.insideGitRepo = gitRoot
  } catch (error) {
    fact.error = String(error?.message ?? error)
  }
  return fact
}

/**
 * 收集待审动作的本地事实。
 * @param exec - 待审的工具调用（含 arguments 与 agent.session.header.cwd）
 * @returns { cwd, facts, notes } —— 失败只记 notes，绝不抛
 */
export function collectLocalFacts(exec) {
  const notes = []
  let cwd
  try {
    cwd = exec?.agent?.session?.header?.cwd
  } catch {
    cwd = undefined
  }
  const facts = []
  try {
    // 用带标注的版本：每个候选带 source（字段可信 / 正文可能碎）与 likelyFragmentOf（疑似碎片，保留不删）
    for (const candidate of extractCandidates(exec?.arguments)) {
      const fact = factFor(candidate.path, cwd)
      if (candidate.source !== undefined) fact.source = candidate.source
      // 碎片标注只在"它自己不存在"时成立：`Copy-Item 'D:\proj' 'D:\proj\backup'` 里
      // `D:\proj` 是另一个候选的前缀，但它是真实目标（存在），不能叫碎片
      if (candidate.likelyFragmentOf !== undefined && fact.exists !== true) {
        fact.likelyFragmentOf = candidate.likelyFragmentOf
      }
      facts.push(fact)
    }
  } catch (error) {
    notes.push('fact collection failed: ' + String(error?.message ?? error))
  }
  // 预览最多保留 MAX_PREVIEWS 个（其余只留 metadata，避免把内容塞满证据）
  let previews = 0
  for (const fact of facts) {
    if (fact.preview === undefined) continue
    previews += 1
    if (previews > MAX_PREVIEWS) delete fact.preview
  }
  if (facts.length === 0) notes.push('no path-like argument found; nothing to verify locally')
  return { cwd: cwd ?? null, facts, notes }
}

/** 渲染成评审证据里的一段（与不可信 transcript 明确分开）。 */
export function renderLocalFacts(localFacts) {
  return JSON.stringify(
    {
      note:
        'Host-verified metadata about paths mentioned by the pending action, read-only, as of now. ' +
        'This is deterministic fact, not agent prose. For at most a couple of small files a bounded preview of ' +
        'the first bytes is included (binary files are never previewed); nothing was modified.',
      ...localFacts,
    },
    null,
    2,
  )
}
