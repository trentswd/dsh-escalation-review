/**
 * reviewer.js —— LLM 评审流水线：取流式判定、解析严格 JSON、失败即拒。
 *
 * 与 policy.js 的分工：policy 决定"给模型看什么、怎么判读文本"（纯函数、可单测），
 * reviewer 决定"怎么拿到模型的回答"（依赖宿主 ctx 的 llm 服务 + 懒加载 BlockAssembler）。
 * 失败路径必须与"政策拒绝"可区分：文案不同、info.reason 可回传模型。
 *
 * 重试语义（2026-09-27 起，按用户定的数字）：
 *   · 最多 3 次（`MAX_REVIEW_ATTEMPTS`）
 *   · **单次尝试上限** `attemptTimeoutMs`（默认 30s）—— 有了它，超时不再等于预算花光
 *   · **总预算** `timeoutMs`（默认 100s）—— 3×30 + 2×5 = 100，正好被兜住
 *   · **重试间隔** `retryDelayMs`（默认 5s，带 0.9–1.1 抖动）
 *   · **可重试**：单次超时、解析/形状错误、限流/过载/5xx/408/429/连接类
 *   · **不重试**：调用方取消、总预算耗尽、输入预算超限、缺 provider/model
 *   · 证据（事实/探针/快照）只算一次；每次尝试只重发请求
 */
import { importDshPackage , lastResolutionRoot} from './dsh-packages.js'

/** 最近一次成功解析 DSH 内部包所用的解析根（导入器可能失败，这里绝不抛）。 */
function safeRoot() {
  try {
    return lastResolutionRoot() ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
import { buildPolicy, buildSnapshot, readDecision, renderSnapshot } from './policy.js'
import { collectLocalFacts } from './facts.js'
import { runSelectedProbes } from './probes.js'

/** 评审自身最多尝试几次（照 Codex `MAX_REVIEW_ATTEMPTS = 3`）。 */
export const MAX_REVIEW_ATTEMPTS = 3
/** 旧退避基数（已被 `retryDelayMs` 取代，保留导出以免打断既有引用）。 */
export const RETRY_BASE_MS = 200

/** 懒解析的 BlockAssembler 缓存：undefined=未解析；null=不可用（走兜底）；function=可用。 */
let assemblerCache
/** 诊断注入（`__diagnostics.setAssembler`）：非 null 时优先使用。 */
let assemblerOverride = null

/** 诊断注入 assembler（index.js 的 `__diagnostics.setAssembler` 转发到这里）。 */
export function setAssemblerOverride(value) {
  assemblerOverride = value
  assemblerCache = undefined
}

/** `ready` 日志里的 assemblerSource：'lazy' | 'test-override'。 */
export function assemblerSourceName() {
  return assemblerOverride === null ? 'lazy' : 'test-override'
}

/**
 * 懒解析 BlockAssembler。
 * 关键：**绝不在注册监听器时 await 这个 import** —— 在 Electron 的 ESM 解析下它可能既不
 * resolve 也不 reject（会让 effect 永久挂住，监听器永远注册不上，且看不到任何日志）。
 * 这里带 3 秒超时，拿不到就返回 null，由 readDecision 走已验证的兜底提取路径。
 */
export async function resolveAssembler(log) {
  if (assemblerOverride !== null) return assemblerOverride
  if (assemblerCache !== undefined) return assemblerCache
  // 用 importDshPackage：GUI 安装是 link: 依赖，模块 URL 落在 workspace，
  // 裸 import('@deepseek-ai/dsh-llm') 会 ERR_MODULE_NOT_FOUND（已实测）。
  try {
    const llm = await Promise.race([
      importDshPackage('@deepseek-ai/dsh-llm'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('import timed out after 3000ms')), 3000)),
    ])
    if (typeof llm?.BlockAssembler === 'function') {
      assemblerCache = llm.BlockAssembler
      log?.write('assembler-resolved', { specifier: '@deepseek-ai/dsh-llm', root: safeRoot() })
      return assemblerCache
    }
  } catch (error) {
    log?.write('assembler-import-failed', {
      specifier: '@deepseek-ai/dsh-llm',
      message: String(error?.message ?? error),
      attempts: error?.attempts,
    })
  }
  assemblerCache = null
  log?.write('assembler-unavailable', { note: '改用从流里提取 JSON 的兜底路径（严格协议不变）' })
  return null
}

/**
 * 这次失败值得重试吗（照 Codex `should_retry_guardian_review`）。
 * 不可重试：超时/取消、缺 provider/model、输入预算类。
 * 可重试：解析与形状错误、限流/过载/5xx/408/429、连接类。
 */
export function isRecoverableReviewError(error) {
  const message = String(error?.message ?? error)
  if (/timed out|timeout|aborted|abort|cancell?ed|signal/i.test(message)) return false
  if (/no (provider|model) available/i.test(message)) return false
  if (/input budget|context window|context length|budget exceeded/i.test(message)) return false
  if (/does not match|unexpected members|must be one JSON object|could not find a JSON|invalid (risk|authorization|outcome)|must carry a reason|must not carry a reason|critical risk|authorization at least/i.test(message)) {
    return true
  }
  if (/rate ?limit|overload|too many|429|408|5\d\d|stream|connection|ECONNRESET|socket|fetch failed/i.test(message)) return true
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))



/**
 * 取 shell 执行器（只给 `probeRunner: 'shell'` 用）。
 * 顺序：agent 的 ctx（agent 本来就在跑命令，那里一定有）→ 插件 ctx。逐段 try（cordis 里访问未声明服务属性会抛）。
 */
function safeGetShell(exec) {
  const scopes = [exec?.agent?.ctx ?? exec?.agent?.context, exec?.agent?.session?.ctx]
  for (const scope of scopes) {
    if (scope === undefined || scope === null) continue
    try {
      if (scope.shell !== undefined && scope.shell !== null) return scope.shell
    } catch {
      /* 未声明时属性访问会抛 */
    }
    try {
      if (typeof scope.get === 'function') {
        const viaGet = scope.get('shell')
        if (viaGet !== undefined && viaGet !== null) return viaGet
      }
    } catch {
      /* get 也可能抛 */
    }
  }
  return undefined
}

export async function review(ctx, exec, cfg, log, effective, extra = {}) {
  const BlockAssembler = await resolveAssembler(log)
  // 只读核实：先收事实（进程内、无命令），再按动作选探针并在额度内执行（固定 argv，无 shell）
  const facts = collectLocalFacts(exec)
  // 探针是**进程内**实现（不 spawn、不依赖宿主内部 spec 契约）
  // 探针通道由配置决定：inproc（默认）或 shell（沙箱内只读命令）；拿不到 ctx.shell 时探针自己回退并记账
  const probeRunner = cfg.probeRunner === 'shell' ? 'shell' : 'inproc'
  const probeOutcome = await runSelectedProbes(exec, facts, {
    runner: probeRunner,
    shell: safeGetShell(exec),
    workdir: exec?.agent?.session?.header?.cwd,
  })
  if (probeOutcome.probes.length > 0 || probeOutcome.budgetExceeded) {
    log?.write('probed', {
      ids: probeOutcome.probes.map((probe) => probe.id),
      budgetExceeded: probeOutcome.budgetExceeded === true,
      ms: probeOutcome.probes.reduce((total, probe) => total + (probe.ms ?? 0), 0),
    })
  }
  const snapshot = buildSnapshot(ctx, exec, effective, cfg, {
    facts,
    ...probeOutcome,
    previousReviews: Array.isArray(extra.previousReviews) ? extra.previousReviews : [],
    currentTurn: extra.turnId,
  })
  // 把"这次评审手里有什么"记下来：否则探针/事实/历史评审是否生效只能靠猜
  log?.write('review-context', {
    facts: snapshot.localFacts?.facts?.length ?? 0,
    probes: (snapshot.probes ?? []).length,
    probeNotes: snapshot.probeNotes ?? [],
    previousReviews: (snapshot.previousReviews ?? []).length,
    previousReviewsWithheld: snapshot.previousReviewsWithheld ?? 0,
    evidenceComplete: snapshot.evidence?.authorizationComplete === true,
    // 每条探针的结果：只记数量的话，"通道可达但命令失败"看不出来（2026-09-27 实测 ms=1 起疑）
    probeResults: (snapshot.probes ?? []).map((probe) => ({
      id: probe.id,
      ok: probe.ok === true,
      ms: probe.ms,
      ...(probe.timedOut === true ? { timedOut: true } : {}),
      ...(probe.skipped === undefined ? {} : { skipped: probe.skipped }),
      ...(probe.runner === undefined ? {} : { runner: probe.runner }),
      ...(probe.sandboxMode === undefined ? {} : { sandboxMode: probe.sandboxMode }),
      // 记下探针"看到了什么"（有界），否则只能看到 ok/失败
      ...(probe.output === undefined ? {} : { output: String(probe.output).slice(0, 80) }),
      ...(probe.error === undefined ? {} : { error: String(probe.error).slice(0, 120) }),
    })),
  })
  const provider = typeof cfg.provider === 'string' && cfg.provider.length > 0 ? cfg.provider : snapshot.provider
  const model = typeof cfg.model === 'string' && cfg.model.length > 0 ? cfg.model : snapshot.model
  if (typeof provider !== 'string' || provider.length === 0) throw new Error('no provider available for the reviewer')
  if (typeof model !== 'string' || model.length === 0) throw new Error('no model available for the reviewer')
  const effort = typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort.trim() : ''
  // 每次尝试都重新渲染（内容一致，成本可忽略），system 只算一次
  const system = buildPolicy(cfg)
  const userText = renderSnapshot(snapshot)
  // 三档超时（2026-09-27 定：单次 30s / 总 100s / 间隔 5s → 3×30 + 2×5 = 100s，正好被总预算兜住）：
  //   · attemptTimeoutMs：**单次尝试**上限。有了它，"本次超时"不再等于"预算花光" → 超时**可以重试**
  //   · timeoutMs：**整个评审**的总预算。调用方（agent）在审批路径里等着，总等待必须有界
  //   · retryDelayMs：两次尝试之间的等待
  const totalTimeoutMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : 100_000
  const attemptTimeoutMs = Math.max(
    1_000,
    Math.min(typeof cfg.attemptTimeoutMs === 'number' && cfg.attemptTimeoutMs > 0 ? cfg.attemptTimeoutMs : 30_000, totalTimeoutMs),
  )
  const retryDelayMs = typeof cfg.retryDelayMs === 'number' && cfg.retryDelayMs >= 0 ? cfg.retryDelayMs : 5_000
  const deadline = Date.now() + totalTimeoutMs
  /** 剩余预算低于这个值就不再开始新尝试（避免白打一次注定失败的上游请求）。可配置。 */
  const minAttemptMs = Math.max(
    0,
    Math.min(typeof cfg.minAttemptMs === 'number' && cfg.minAttemptMs >= 0 ? cfg.minAttemptMs : 2_000, attemptTimeoutMs),
  )

  /** 单次尝试：超时取"单次上限"与"剩余总预算"里更小的那个。 */
  const attemptOnce = async () => {
    const remaining = Math.max(1, deadline - Date.now())
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(attemptTimeoutMs, remaining)))
    const signal = exec?.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
    const stream = ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      temperature: 0,
      // 思考强度：留空＝交给 provider/模型默认（与 Composer 的"思考强度"同义）
      ...(effort === '' ? {} : { reasoningEffort: effort }),
      signal,
    })
    return readDecision(stream, BlockAssembler ?? undefined)
  }

  let attempt = 1
  for (;;) {
    try {
      const decision = await attemptOnce()
      if (attempt > 1) log?.write('review-succeeded-after-retry', { attempt })
      // 本次判定的授权版本（照 Codex GuardianAuthorizationVersion）：调用方按它给历史评审打标
      return { ...decision, authorizationVersion: snapshot.authorizationVersion }
    } catch (error) {
      const message = String(error?.message ?? error)
      const remaining = deadline - Date.now()
      // 区分三种"中止"：① 调用方取消（不重试）② 总预算耗尽（不重试）③ 本次尝试超时（**可以**重试）
      const callerAborted = exec?.signal?.aborted === true
      const totalExpired = Date.now() >= deadline || remaining <= 0
      const attemptTimedOut = !callerAborted && !totalExpired && /timed out|timeout|aborted|abort/i.test(message)
      const retryable = isRecoverableReviewError(error) || attemptTimedOut
      if (attempt >= MAX_REVIEW_ATTEMPTS || !retryable || totalExpired) throw error
      const jitter = 0.9 + Math.random() * 0.2
      const delay = Math.min(Math.round(retryDelayMs * jitter), Math.max(0, remaining - 1))
      // 预算不足就不再开始"注定失败"的尝试（否则会白打一次上游请求）
      if (remaining - delay < minAttemptMs) {
        log?.write('review-retry-skipped', {
          attempt,
          reason: 'insufficient-budget',
          remainingMs: remaining,
          plannedDelayMs: delay,
          minAttemptMs,
          message: message.slice(0, 200),
        })
        throw error
      }
      log?.write('review-retry', {
        attempt,
        reason: attemptTimedOut ? 'attempt-timeout' : 'error',
        delayMs: delay,
        remainingMs: remaining,
        attemptTimeoutMs,
        totalTimeoutMs,
        message: message.slice(0, 200),
      })
      await sleep(delay)
      if (Date.now() >= deadline) throw error
      attempt += 1
    }
  }
}
