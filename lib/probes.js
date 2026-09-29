/**
 * probes.js —— 受限只读探针（**两条通道**，由配置 `probeRunner` 切换）
 *
 *   ① `inproc`（默认）：进程内实现，**不 spawn 任何进程**
 *      —— 能力最小、无宿主契约依赖、离线可端到端测（真起监听端口 / 真查 git 树）
 *   ② `shell`：在**沙箱内**跑固定只读命令（`ctx.shell`）
 *      —— 用真契约：`shell.resolve(request)` → `shell.execute(spec)` → `handle.result()`
 *        （2026-09-27 从 @deepseek-ai/dsh-shell 的真类型确认；`resolve` 负责补齐 spec 并盖上沙箱策略）
 *        `sandboxPolicy: { mode: 'read-only', workspaceRoot }` —— 探针不需要写
 *        `run.sandbox` 会回报实际沙箱事实，所以"是否真在沙箱里"可被观察
 *      —— 拿不到 `ctx.shell` 时**自动回退**到 inproc 并在证据里记 `fellBackTo`
 *
 * 两条通道共守的纪律：
 *   · 参数过严格白名单（模型永远不能提供命令，只能给端口/pid/目录）
 *   · 每次评审有额度：最多 MAX_PROBES 个、总预算 PROBE_BUDGET_MS、单个超时 PROBE_TIMEOUT_MS、输出截断
 *   · **由待审动作推导该跑哪些探针**（不是模型挑）
 *   · 全程 try，失败只记 error，绝不抛
 *
 * 踩过的坑（别再犯）：把"请求形状"的对象直接喂 `executeArgv` → 缺 `workdir`（spec 必填）→
 * 内部抛 `Cannot read properties of undefined (reading 'includes')`；且公开入口是 `execute(spec)`。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

export const MAX_PROBES = 4
export const PROBE_BUDGET_MS = 3_000
export const PROBE_TIMEOUT_MS = 1_200
export const MAX_OUTPUT_BYTES = 2_048

const IS_WINDOWS = process.platform === 'win32'

/** 参数校验器：只接受窄形状，任何越界直接拒绝（不进入任何执行路径）。 */
const validators = {
  port: (value) => {
    const text = String(value)
    return /^\d{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535 ? Number(text) : undefined
  },
  pid: (value) => {
    const text = String(value)
    return /^\d{1,7}$/.test(text) ? Number(text) : undefined
  },
  directory: (value) => {
    const text = String(value)
    if (text.length === 0 || text.length > 260 || text.includes('\u0000')) return undefined
    // 连引号也拒：命令模板会把它插进引号里，允许引号就有拼接风险
    return /[|&;<>$`"']/.test(text) ? undefined : text
  },
}

/** 向上找 git 根（最多 6 层）。 */
function findGitRoot(start) {
  let current = start
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

/** 从 `.git/config` 里取 origin 的 url（有界读取，不执行 git）。 */
function readOriginUrl(gitRoot) {
  const candidates = [join(gitRoot, '.git', 'config'), join(gitRoot, '.git')]
  for (const file of candidates) {
    try {
      if (!existsSync(file) || statSync(file).isDirectory()) continue
      const text = readFileSync(file, 'utf8').slice(0, 16_384)
      const section = text.match(/\[remote "origin"\]([\s\S]{0,400}?)(\n\[|$)/)
      if (section === null) continue
      const url = section[1].match(/url\s*=\s*(\S+)/)
      if (url !== null) return url[1]
    } catch {
      /* 读不到就换下一个候选 */
    }
  }
  return undefined
}

/** 试连本地端口（只连不发数据；连上即认为在监听）。 */
function tryConnect(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let socket
    try {
      socket = connect({ host: '127.0.0.1', port })
    } catch (error) {
      finish({ ok: true, output: 'closed', note: String(error?.message ?? error).slice(0, 120) })
      return
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish({ ok: true, output: 'listening' })
      socket.destroy()
    })
    socket.once('timeout', () => {
      finish({ ok: true, output: 'closed', note: 'connect timeout' })
      socket.destroy()
    })
    socket.once('error', (error) => {
      const code = String(error?.code ?? '')
      finish({ ok: true, output: code === 'ECONNREFUSED' ? 'closed' : 'unknown', note: code || String(error?.message ?? '') })
      socket.destroy()
    })
  })
}

/**
 * 探针白名单。每条声明：
 *   · arg        参数类型（决定白名单校验器）
 *   · readOnly   只读
 *   · run        进程内实现（inproc 通道）
 *   · command    沙箱内固定命令模板（shell 通道；参数已过校验，故可安全插入）
 */
export const PROBES = {
  gitInsideWorkTree: {
    id: 'gitInsideWorkTree',
    arg: 'directory',
    readOnly: true,
    describe: '判断目录（或其祖先）是否 git 工作树',
    run: async (directory) => ({ ok: true, output: findGitRoot(directory) === undefined ? 'false' : 'true' }),
    command: (directory) => `git -C "${directory}" rev-parse --is-inside-work-tree`,
  },
  gitRemoteOrigin: {
    id: 'gitRemoteOrigin',
    arg: 'directory',
    readOnly: true,
    describe: '取 remote origin 的 url（进程内读 .git/config；命令通道用 git config --get）',
    run: async (directory) => {
      const root = findGitRoot(directory)
      if (root === undefined) return { ok: true, output: 'not a git work tree' }
      const url = readOriginUrl(root)
      return { ok: true, output: url ?? 'no origin remote' }
    },
    command: (directory) => `git -C "${directory}" config --get remote.origin.url`,
    // git config --get 在"键不存在"时退出 1 —— 那是**查询成功但没有该键**，不是失败
    okExitCodes: [0, 1],
    normalize: (output) => (output.length === 0 ? 'no origin remote' : output),
  },
  portListening: {
    id: 'portListening',
    arg: 'port',
    readOnly: true,
    describe: '本地端口是否有人在监听（进程内试连；命令通道用 netstat/ss）',
    run: async (port, options = {}) => tryConnect(port, options.timeoutMs ?? PROBE_TIMEOUT_MS),
    command: (port) =>
      IS_WINDOWS
        ? `netstat -ano | findstr /R /C:":${port} .*LISTENING"`
        : `ss -ltn | grep -c ":${port} "`,
    // findstr / grep 在**没有匹配**时退出 1 —— 那是"没人在监听"，不是命令失败
    okExitCodes: [0, 1],
    normalize: (output) => {
      if (output.length > 0) return 'listening'
      return 'closed'
    },
  },
  processAlive: {
    id: 'processAlive',
    arg: 'pid',
    readOnly: true,
    describe: '进程是否存在（进程内 process.kill(pid,0)；命令通道用 Get-Process/kill -0）',
    run: async (pid) => {
      try {
        process.kill(pid, 0)
        return { ok: true, output: 'alive' }
      } catch (error) {
        const code = String(error?.code ?? '')
        return { ok: true, output: code === 'ESRCH' ? 'not running' : 'unknown', note: code || String(error?.message ?? '') }
      }
    },
    command: (pid) =>
      IS_WINDOWS
        ? `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id`
        : `kill -0 ${pid} && echo alive`,
    // Get-Process / kill -0 在"进程不存在"时退出 1 —— 那是"没在跑"，不是命令失败
    okExitCodes: [0, 1],
    normalize: (output) => (output.length === 0 ? 'not running' : 'alive'),
  },
}

/** 走沙箱通道：resolve → execute → result（真契约，见文件头）。 */
async function runViaShell(probe, validated, options) {
  const shell = options.shell
  const workdir = options.workdir ?? process.cwd()
  const request = {
    command: probe.command(validated),
    workdir,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    onExpiry: 'kill',
    stdoutMaxBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    // 探针只读：显式用 read-only 档（resolve 会据此盖上沙箱策略）
    sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
  }
  const spec = typeof shell.resolve === 'function' ? shell.resolve(request) : request
  const handle = await shell.execute(spec)
  const run = await handle.result()
  const rawOutput = String(run?.stdout?.text ?? '').trim()
  const output = typeof probe.normalize === 'function' ? String(probe.normalize(rawOutput)) : rawOutput
  const exitCode = run?.exitCode ?? null
  const okCodes = Array.isArray(probe.okExitCodes) ? probe.okExitCodes : [0]
  return {
    // 退出码按探针声明判定（例：git config --get 查不到键时退出 1，那仍算"查到了答案"）
    ok: run?.timedOut !== true && run?.aborted !== true && exitCode !== null && okCodes.includes(exitCode),
    output,
    ...(run?.timedOut === true ? { timedOut: true } : {}),
    ...(exitCode === null ? {} : { exitCode }),
    // run.sandbox 是执行器回报的实际沙箱事实 —— 用来确认"真的在沙箱里"
    ...(run?.sandbox === undefined ? {} : { sandbox: run.sandbox }),
  }
}

/**
 * 执行一个探针。
 * @param probe - 白名单探针
 * @param rawArg - 原始参数（必须过白名单校验）
 * @param options - { runner: 'inproc'|'shell', shell, workdir, timeoutMs, maxOutputBytes }
 */
export async function runProbe(probe, rawArg, options = {}) {
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const requested = options.runner === 'shell' ? 'shell' : 'inproc'
  const result = { id: probe.id, arg: rawArg, readOnly: probe.readOnly === true }
  const validated = validators[probe.arg](rawArg)
  if (validated === undefined) {
    result.rejected = 'argument does not match the allowlist shape'
    return result
  }
  result.validatedArg = validated
  // 想要沙箱通道但没有 shell 服务 → 回退 inproc，并如实记账
  const useShell = requested === 'shell' && options.shell !== undefined && options.shell !== null
  const runner = useShell ? 'shell' : 'inproc'
  const fellBackTo = requested === 'shell' && !useShell ? 'inproc' : undefined
  const started = Date.now()
  try {
    const outcome = useShell
      ? await runViaShell(probe, validated, { ...options, maxOutputBytes: maxBytes })
      : await probe.run(validated, { timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS })
    return {
      ...result,
      runner,
      ...(fellBackTo === undefined ? {} : { fellBackTo }),
      ok: outcome?.ok === true,
      output: String(outcome?.output ?? '').slice(0, maxBytes),
      ...(outcome?.note === undefined ? {} : { note: String(outcome.note).slice(0, 200) }),
      ...(outcome?.timedOut === true ? { timedOut: true } : {}),
      ...(outcome?.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      ...(outcome?.sandbox === undefined ? {} : { sandboxMode: outcome.sandbox?.mode }),
      ms: Date.now() - started,
    }
  } catch (error) {
    return {
      ...result,
      runner,
      ...(fellBackTo === undefined ? {} : { fellBackTo }),
      ok: false,
      error: String(error?.message ?? error).slice(0, 200),
      stack: String(error?.stack ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 300),
      ms: Date.now() - started,
    }
  }
}

/** 从待审动作里推导出"值得跑"的探针（不是模型挑）。 */
export function selectProbes(exec, facts) {
  const selected = []
  const args = exec?.arguments ?? {}
  // 只在**命令正文**里找触发词：整个 arguments 的 JSON 里混着 description 与理由，
  // 会把"路径里含 Git""理由里提端口"当成触发条件（实测误触发过）。
  const command = typeof args.command === 'string' ? args.command : JSON.stringify(args)
  // git 探针：必须真的在调 git，而不是路径里出现 Git 三个字母
  const gitInvocation = /(^|[\s;&|("'])git(\.exe)?\s+(-C\s|status|remote|rev-parse|log|diff|ls-files|branch|show)/i.test(command)
  if (gitInvocation) {
    // 目录用会话 cwd：不再从命令文本里解析路径（2026-09-27 退役路径解析）
    const cwd = (() => {
      try {
        return exec?.agent?.session?.header?.cwd
      } catch {
        return undefined
      }
    })()
    if (typeof cwd === 'string' && cwd.length > 0) {
      selected.push({ probe: PROBES.gitInsideWorkTree, arg: cwd })
      selected.push({ probe: PROBES.gitRemoteOrigin, arg: cwd })
    }
  }
  // 端口探针：端口必须出现在**监听/服务语境附近**（孤零零的数字、或隔着半条命令的数字都不算）
  const portCtx = command.match(/(?:listen|serve|--port|监听)[^\n]{0,40}?(\d{2,5})\b|(\d{2,5})\b[^\n]{0,20}?(?:listen|监听)/i)
  if (portCtx !== null) {
    const port = portCtx[1] ?? portCtx[2]
    if (port !== undefined) selected.push({ probe: PROBES.portListening, arg: port })
  }
  const pidMatch = command.match(/\bpid[=: ]+(\d{1,7})\b/i)
  if (pidMatch !== null) selected.push({ probe: PROBES.processAlive, arg: pidMatch[1] })
  return selected.slice(0, MAX_PROBES)
}

/** 在额度内依次执行选中的探针；超预算即停并标记。 */
export async function runSelectedProbes(exec, facts, options = {}) {
  const budgetMs = options.budgetMs ?? PROBE_BUDGET_MS
  const maxProbes = options.maxProbes ?? MAX_PROBES
  const runner = options.runner === 'shell' ? 'shell' : 'inproc'
  const selected = selectProbes(exec, facts).slice(0, maxProbes)
  const probes = []
  const notes = []
  const started = Date.now()
  let budgetExceeded = false
  if (runner === 'shell' && (options.shell === undefined || options.shell === null)) {
    notes.push('shell runner requested but ctx.shell unavailable; fell back to in-process probes')
  }
  for (const item of selected) {
    if (Date.now() - started > budgetMs) {
      budgetExceeded = true
      notes.push('probe budget exhausted; remaining probes skipped')
      break
    }
    const remaining = Math.max(200, budgetMs - (Date.now() - started))
    probes.push(
      await runProbe(item.probe, item.arg, {
        runner,
        shell: options.shell,
        workdir: options.workdir,
        timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining),
      }),
    )
  }
  if (selected.length === 0) notes.push('no probe was warranted by this action')
  return { probes, notes, budgetExceeded, budgetMs, maxProbes, runner }
}
