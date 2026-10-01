/**
 * probes.js —— 受限只读探针（**两条通道**，由配置 `probeRunner` 切换）
 *
 *   ① `shell`（**默认**）：在**沙箱内**跑固定只读命令，且**必须**用 `verify.js` 配对通道的兄弟 shell
 *      （同 scope、同 execution world）—— 拿不到就 `probe-unavailable`，**绝不回退**进程内
 *   ② `inproc`：进程内实现，**不 spawn 任何进程**；只跑 `filesystem` 类探针，
 *      且只在能证明世界是宿主时才跑（`process` 类的端口/PID **一律不走进程内**）
 *
 * 两条通道共守的纪律：
 *   · 参数过严格白名单（模型永远不能提供命令，只能给端口/pid/目录）
 *   · 每次评审有额度：最多 MAX_PROBES 个、总预算 PROBE_BUDGET_MS、单个超时 PROBE_TIMEOUT_MS、输出截断
 *   · **由待审动作推导该跑哪些探针**（不是模型挑）
 *   · shell 通道执行后**必须**核对 `run.sandbox`：缺失 / 档位不是 read-only / runnerFailed / denied
 *     → 丢弃 stdout、标失败（与主 verify tools 同一套标准，第六轮 P1-2）
 *   · 全程 try，失败只记 error，绝不抛
 *
 * 踩过的坑（别再犯）：把"请求形状"的对象直接喂 `executeArgv` → 缺 `workdir`（spec 必填）→
 * 内部抛 `Cannot read properties of undefined (reading 'includes')`；且公开入口是 `execute(spec)`。
 */
import { connect } from 'node:net'

export const MAX_PROBES = 4
export const PROBE_BUDGET_MS = 3_000
export const PROBE_TIMEOUT_MS = 1_200
export const MAX_OUTPUT_BYTES = 2_048
/**
 * 剩余预算小于这个值就不再开新探针（第七轮 R1）：
 * ⚠️ **绝不放大** —— 以前是 `Math.max(200, remaining)`，会把 20ms 的真实剩余预算变成 200ms，
 * 等于偷偷延长了整次评审的承诺时长。宁可跳过（记账 `budgetExceeded`）。
 */
export const PROBE_MIN_SLICE_MS = 50

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
}

/**
 * ⚠️ 这里原本有 git 探针（`findGitRoot` / `readOriginUrl` / `sanitizeRemoteUrl`）——
 * **第六轮已整体退休**（用户决定 + review P1-4）。两个理由：
 *   ① 它是"宿主前分析"，而探针的目标目录是**会话 cwd**，不是命令 `-C` 指向的路径 →
 *      `git -C <别的仓库> push --force` 会拿到"不是 git 工作树 / 没有 remote"这类**低估风险**的事实；
 *   ② `git config --get` 在非仓库目录还会读**全局配置**，答案与动作目标无关。
 * 需要"这是不是仓库 / remote 是什么"时，让评审用自己的只读工具，或直接不放行。
 * 端口/PID 两类保留 —— 它们的事实评审**无法**自己取得（它没有 shell），且已强制走动作所在世界的 shell。
 * 退休后本文件**不再 import `node:fs` / `node:path`**：公共库对文件系统的访问只剩宿主沙箱通道。
 */

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
  portListening: {
    id: 'portListening',
    arg: 'port',
    readOnly: true,
    // `process` 类：结论依赖 **PID / 网络命名空间** —— 文件系统映射**证明不了**它与宿主同命名空间，
    // 所以这类探针**绝不**用进程内实现（第五轮 P1-E）：只能走待审动作所在世界的配对 shell。
    worldClass: 'process',
    describe: '本地端口是否有人在监听（命令通道用 netstat/ss；进程内实现仅限显式 inproc 且世界可证明）',
    run: async (port, options = {}) => tryConnect(port, options.timeoutMs ?? PROBE_TIMEOUT_MS),
    command: (port) =>
      IS_WINDOWS
        ? `netstat -ano | findstr /R /C:":${port} .*LISTENING"`
        : `ss -ltn | grep -c ":${port} "`,
    // findstr / grep 在**没有匹配**时退出 1 —— 那是"没人在监听"，不是命令失败
    okExitCodes: [0, 1],
    // ⚠️ Linux 的 `ss -ltn | grep -c` 在"没人在听"时输出 `0` 且退出 1：必须按**数字**判，
    //    不能按"有没有输出"判，否则 `"0"` 会被当成 listening（第六轮 review P2-5）。
    normalize: (output) => {
      const text = String(output ?? '').trim()
      if (text.length === 0) return 'closed'
      const count = Number.parseInt(text, 10)
      if (Number.isFinite(count)) return count > 0 ? 'listening' : 'closed'
      return 'listening' // Windows 的 findstr 路径给的是匹配行文本，非空即有人在听
    },
  },
  processAlive: {
    id: 'processAlive',
    arg: 'pid',
    readOnly: true,
    worldClass: 'process',
    describe: '进程是否存在（命令通道用 Get-Process/kill -0；进程内实现仅限显式 inproc 且世界可证明）',
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

/**
 * 插件自持的**硬截止**（第七轮 R1）：即使 provider 完全不返回，也在这里收尾。
 * 超时返回 `undefined`，并调用 `onTimeout`（用来 kill/dispose 已拿到的 handle）。
 * ⚠️ 被弃置的那个 promise 必须挂一个 catch —— 否则它稍后拒绝会变成 unhandled rejection。
 */
function hardDeadline(promise, deadline, now, onTimeout) {
  const remaining = Math.max(0, deadline - now())
  if (remaining <= 0) {
    try { onTimeout?.() } catch { /* 尽力而为 */ }
    return Promise.resolve(undefined)
  }
  let timer
  const timeout = new Promise((resolve) => {
    // ⚠️ **不能 unref**：unref 的定时器在安静进程里可能永远不触发（测试里表现为进程直接退出），
    //    而硬截止的意义就是"无论如何都要收尾"。它很短（≤ 单条探针上限）且结算时会被 clear。
    timer = setTimeout(() => {
      try { onTimeout?.() } catch { /* 尽力而为 */ }
      resolve(undefined)
    }, remaining)
  })
  const settled = Promise.resolve(promise).then((value) => value, () => undefined)
  settled.catch(() => { /* 弃置分支：吞掉晚到的拒绝 */ })
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
}

/** 走沙箱通道：resolve → execute → result（真契约，见文件头）。 */
async function runViaShell(probe, validated, options) {
  const shell = options.shell
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sliceMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : PROBE_TIMEOUT_MS
  // ⚠️ 第七轮 R1：**插件自己掌握绝对 deadline** —— provider 卡在 resolve/execute/result 任何一段，
  //    我们都必须在这里收尾（主 verify tools 早有 withDeadline，探针以前只有 request 的 timeoutMs）。
  const deadline = typeof options.deadline === 'number' ? options.deadline : now() + sliceMs
  if (deadline - now() <= 0) return { ok: false, error: 'probe-deadline-exceeded', output: '' }
  const workdir = options.workdir ?? process.cwd()
  let handle
  const abort = () => {
    try { handle?.kill?.() } catch { /* 尽力而为 */ }
    try { handle?.dispose?.() } catch { /* 尽力而为 */ }
  }
  const request = {
    command: probe.command(validated),
    workdir,
    timeoutMs: Math.min(sliceMs, Math.max(0, deadline - now())),
    onExpiry: 'kill',
    stdoutMaxBytes: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    // 探针只读：显式用 read-only 档（resolve 会据此盖上沙箱策略）
    sandboxPolicy: { mode: 'read-only', workspaceRoot: workdir },
    // 调用方取消信号（动作被中止时探针也必须停）
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const spec = await hardDeadline(
    Promise.resolve().then(() => (typeof shell.resolve === 'function' ? shell.resolve(request) : request)),
    deadline, now, abort,
  )
  if (spec === undefined) return { ok: false, error: 'probe-timeout', output: '' }
  handle = await hardDeadline(Promise.resolve().then(() => shell.execute(spec)), deadline, now, abort)
  if (handle === undefined || handle === null) return { ok: false, error: 'probe-timeout', output: '' }
  const run = await hardDeadline(
    Promise.resolve().then(() => handle.result()),
    deadline, now, abort,
  )
  if (run === undefined) return { ok: false, error: 'probe-timeout', output: '' }
  const exitCode = run?.exitCode ?? null
  const okCodes = Array.isArray(probe.okExitCodes) ? probe.okExitCodes : [0]
  const codeOk = run?.timedOut !== true && run?.aborted !== true && exitCode !== null && okCodes.includes(exitCode)
  // ⚠️ 第六轮 P1-2：探针和主 verify tools 必须用**同一套沙箱事实检查** ——
  //    执行器没回报沙箱事实 / 档位不符 / runnerFailed / denied → **丢弃 stdout、标失败**。
  //    绝不把"我们请求了 read-only"写成"确实在 read-only 里跑的"，更不把未沙箱的输出当事实喂给评审。
  const facts = run?.sandbox
  const sandboxOk = facts !== undefined && facts !== null && typeof facts === 'object' &&
    String(facts.mode ?? '') === 'read-only' && facts.runnerFailed !== true && facts.denied !== true
  if (!sandboxOk) {
    return {
      ok: false,
      output: '',
      error: facts === undefined || facts === null ? 'no-sandbox-facts' : `sandbox-facts-rejected:${facts.mode ?? 'unknown'}`,
      ...(exitCode === null ? {} : { exitCode }),
      ...(facts === undefined ? {} : { sandbox: facts }),
    }
  }
  const rawOutput = String(run?.stdout?.text ?? '').trim()
  const output = typeof probe.normalize === 'function' ? String(probe.normalize(rawOutput)) : rawOutput
  return {
    // 退出码按探针声明判定（例：git config --get 查不到键时退出 1，那仍算"查到了答案"）
    ok: codeOk,
    output,
    ...(run?.timedOut === true ? { timedOut: true } : {}),
    ...(exitCode === null ? {} : { exitCode }),
    sandbox: facts,
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
  // ⚠️ inproc 探针跑在**宿主进程**里（`node:fs` / loopback socket / `process.kill`），
  //    只能证明**宿主**事实。调用方必须声明世界（`verify.js` 的 `hostWorldProof`）；
  //    不可证明为宿主时**拒绝执行** —— 绝不把宿主机器的事实当成本次动作的事实（第四轮 review P1-B）。
  const world = options.world === 'host' ? 'host' : 'unproven'
  if (requested === 'inproc' && world !== 'host') {
    return { ...result, skipped: 'wrong-execution-world' }
  }
  // `process` 类（端口 / PID）**绝不**用进程内实现：`processPathFromHostPath` 只能证明文件系统可映射，
  // 证明不了 PID / 网络命名空间与宿主相同（第五轮 P1-E）。它们只能走待审动作所在世界的配对 shell。
  if (requested === 'inproc' && probe.worldClass === 'process') {
    return { ...result, skipped: 'inproc-cannot-attest-process-world' }
  }
  // 想要沙箱通道但没有配对 shell → **不可用**（与 runSelectedProbes 同一口径）：
  // 回退进程内等于用宿主机器的事实冒充动作世界的事实（第五轮 P1-E）。
  const useShell = requested === 'shell' && options.shell !== undefined && options.shell !== null
  if (requested === 'shell' && !useShell) {
    return { ...result, skipped: 'probe-unavailable' }
  }
  const runner = useShell ? 'shell' : 'inproc'
  // 注入时钟（第七轮 R1）：与 reviewer 的时钟统一，便于确定性复现
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const started = now()
  try {
    const outcome = useShell
      ? await runViaShell(probe, validated, { ...options, maxOutputBytes: maxBytes, now })
      : await probe.run(validated, { timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS })
    return {
      ...result,
      runner,
      ok: outcome?.ok === true,
      output: String(outcome?.output ?? '').slice(0, maxBytes),
      // 失败原因也要透出来（第七轮 R1：硬截止超时是 `probe-timeout`，不能只剩 ok=false）
      ...(outcome?.error === undefined ? {} : { error: String(outcome.error).slice(0, 200) }),
      ...(outcome?.note === undefined ? {} : { note: String(outcome.note).slice(0, 200) }),
      ...(outcome?.timedOut === true ? { timedOut: true } : {}),
      ...(outcome?.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      ...(outcome?.sandbox === undefined ? {} : { sandboxMode: outcome.sandbox?.mode }),
      ms: now() - started,
    }
  } catch (error) {
    return {
      ...result,
      runner,
      ok: false,
      error: String(error?.message ?? error).slice(0, 200),
      stack: String(error?.stack ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 300),
      ms: now() - started,
    }
  }
}

/**
 * 从待审动作里推导出"值得跑"的探针（不是模型挑）。
 * ⚠️ 只读 `exec.arguments`（命令正文）与会话 cwd —— 2026-09-30 起**不再接收 facts**：
 *    那批宿主 fs metadata 从来没被这个函数读过（纯成本），已整体删除（见 facts.js 头部）。
 */
export function selectProbes(exec) {
  const selected = []
  const args = exec?.arguments ?? {}
  // 只在**命令正文**里找触发词：整个 arguments 的 JSON 里混着 description 与理由，
  // 会把"路径里含 Git""理由里提端口"当成触发条件（实测误触发过）。
  const command = typeof args.command === 'string' ? args.command : JSON.stringify(args)
  // ⚠️ git 探针已退休（第六轮）：它读的是**会话 cwd** 而不是命令 `-C` 指向的路径，
  //    对 `git -C <别的仓库> …` 会给出"不是 git 工作树 / 没有 remote"这类**低估风险**的事实。
  //    需要"这是不是仓库 / remote 是什么"时，让评审用自己的只读工具（或直接不放行）。
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
export async function runSelectedProbes(exec, options = {}) {
  const budgetMs = options.budgetMs ?? PROBE_BUDGET_MS
  const maxProbes = options.maxProbes ?? MAX_PROBES
  const runner = options.runner === 'shell' ? 'shell' : 'inproc'
  // ⚠️ 探针只能证明**宿主**事实，所以先问世界（`verify.js` 的 `hostWorldProof`，由 reviewer.js 传入）：
  //    · inproc 且世界**不可证明**为宿主 → 整个跳过（wrong-execution-world），绝不跑宿主探针；
  //    · 想要 shell 探针但拿不到沙箱 shell，且世界不可证明为宿主 → 探针不可用（probe-unavailable），
  //      **绝不回退到宿主 inproc**（旧行为对 remote 动作会喂错机器的事实）。
  const world = options.world === 'host' ? 'host' : 'unproven'
  const skip = (skipped, note) => ({ probes: [], notes: [note], skipped, world, budgetExceeded: false, budgetMs, maxProbes, runner })
  if (runner === 'inproc' && world !== 'host') {
    return skip('wrong-execution-world', "in-process probes skipped: this action's execution world is not provably the host (unverified-world)")
  }
  const shellAvailable = options.shell !== undefined && options.shell !== null
  // 想要 shell 探针却没有配对 shell → **不回退**进程内（第五轮 P1-E）：回退等于用宿主机器的事实
  // 冒充待审动作所在世界的事实。宁可没有事实。
  if (runner === 'shell' && !shellAvailable) {
    return skip('probe-unavailable', 'sandbox shell probes are unavailable; probes skipped (no fallback to in-process probes)')
  }
  const selected = selectProbes(exec).slice(0, maxProbes)
  const probes = []
  const notes = []
  // 注入时钟（第七轮 R1：以前这里混用 `Date.now()`，与 reviewer 的注入时钟不一致）
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const started = now()
  const deadline = started + budgetMs
  let budgetExceeded = false
  // 进程内通道只跑 `filesystem` 类：`process` 类（端口/PID）在别的世界里查不到（见 runProbe 的守卫）
  const runnable = runner === 'shell' ? selected : selected.filter((item) => item.probe.worldClass !== 'process')
  if (runnable.length < selected.length) {
    notes.push('process/network probes skipped: an in-process probe cannot attest another world PID or network namespace')
  }
  for (const item of runnable) {
    const remaining = budgetMs - (now() - started)
    // ⚠️ **不放大**剩余预算（第七轮 R1）：小于最小片就直接跳过并记账，绝不把 20ms 变成 200ms
    if (remaining < PROBE_MIN_SLICE_MS) {
      budgetExceeded = true
      notes.push('probe budget exhausted; remaining probes skipped')
      break
    }
    probes.push(
      await runProbe(item.probe, item.arg, {
        runner,
        shell: options.shell,
        workdir: options.workdir,
        timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining),
        world,
        now,
        deadline,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    )
  }
  if (selected.length === 0) notes.push('no probe was warranted by this action')
  return { probes, notes, budgetExceeded, budgetMs, maxProbes, runner, world }
}
