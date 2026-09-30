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
import { buildPolicy, buildSnapshot, readAssistantText, renderSnapshot } from './policy.js'
import { VERIFY_MAX_STEPS, VERIFY_MAX_TOOL_BATCHES, VERIFY_MAX_TOOL_CALLS, runReviewLoop } from './verify.js'
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
  // 协议/形状错误（输出不是恰好一个 JSON 对象等）明确可重试 —— 由 verify.js 打标
  if (error?.reviewProtocol === true) return true
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
  // 只读核实：按动作选只读探针并在额度内执行（固定 argv，无 shell），**探针结果**进证据。
  // ⚠️ 2026-09-30：原先那层"宿主本地事实"（`collectLocalFacts` 的 lstat/readdir metadata）**已删** ——
  //    选探针根本不用它的内容，它只是一条"绕过沙箱通道的进程内 fs 观察"（权限成本、零功能收益）。
  //    要读文件/目录一律走 verify.js 的只读工具（沙箱通道 + 路径策略 + canonicalize）。
  // 探针通道由配置决定：inproc（默认）或 shell（沙箱内只读命令）；拿不到 ctx.shell 时探针自己回退并记账
  const probeRunner = cfg.probeRunner === 'shell' ? 'shell' : 'inproc'
  const probeOutcome = await runSelectedProbes(exec, {
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
  // 每次尝试都重新渲染（内容一致，成本可忽略），system 只算一次。
  // 只读工具是否可用（off = 关；on/auto/always 都算开 —— auto/always 是旧配置的别名，
  // sanitize 已把它们规范成 'on'，这里再兜一层）。关掉时 prompt 里不含工具协议。
  const toolsEnabled = cfg.verifyMode !== 'off'
  // 评审请求里**不含**任何人工改判信号（对齐 Codex：评审判定的来源只有 agent）。
  // 想改变评审口径请写 `policyExtra`（等价 Codex 的 `auto_review.extra_policy`）。
  const system = buildPolicy(cfg, { tools: toolsEnabled })
  const userText = toolsEnabled
    ? [
        renderSnapshot(snapshot),
        '',
        `Step 1 of at most ${VERIFY_MAX_STEPS}: if the evidence above is sufficient, return the verdict JSON now.`,
        `Only if one specific missing fact could materially change the verdict, ask for one batch of read-only tools`,
        `(at most ${VERIFY_MAX_TOOL_BATCHES} batches and ${VERIFY_MAX_TOOL_CALLS} tool calls in total).`,
        'Do not gather facts merely for completeness.',
      ].join('\n')
    : renderSnapshot(snapshot)
  // 三档超时（2026-09-27 定：单次 30s / 总 100s / 间隔 5s → 3×30 + 2×5 = 100s，正好被总预算兜住）：
  //   · attemptTimeoutMs：**单次尝试**上限。有了它，"本次超时"不再等于"预算花光" → 超时**可以重试**
  //   · timeoutMs：**整个评审**的总预算。调用方（agent）在审批路径里等着，总等待必须有界
  //   · retryDelayMs：两次尝试之间的等待
  //   · queueWaitMs：在并行评审池里排队等待的毫秒数 —— 从总预算里**扣掉**，
  //     这样"排队 + 评审"的总时长仍受 timeoutMs 约束（默认并发 1 时时长为 0）
  const configuredBudgetMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? cfg.timeoutMs : 100_000
  const queueWaitMs = Number.isFinite(extra.queueWaitMs) && extra.queueWaitMs > 0 ? extra.queueWaitMs : 0
  const totalTimeoutMs = Math.max(1, configuredBudgetMs - queueWaitMs)
  // 排队把预算等没了：不要再打一次注定超时的请求（调用方按 fail-closed 处理）
  if (queueWaitMs > 0 && totalTimeoutMs <= 1) throw new Error('the review slot wait consumed the whole review budget')
  // 时钟/抖动/等待都可注入（默认真实实现）：预算判定必须能被确定性地复现，不受机器负载影响。
  const now = typeof extra.now === 'function' ? extra.now : () => Date.now()
  const random = typeof extra.random === 'function' ? extra.random : Math.random
  const wait = typeof extra.sleep === 'function' ? extra.sleep : sleep
  const attemptTimeoutMs = Math.max(
    1_000,
    Math.min(typeof cfg.attemptTimeoutMs === 'number' && cfg.attemptTimeoutMs > 0 ? cfg.attemptTimeoutMs : 30_000, totalTimeoutMs),
  )
  const retryDelayMs = typeof cfg.retryDelayMs === 'number' && cfg.retryDelayMs >= 0 ? cfg.retryDelayMs : 5_000
  const deadline = now() + totalTimeoutMs
  /** 剩余预算低于这个值就不再开始新尝试（避免白打一次注定失败的上游请求）。可配置。 */
  const minAttemptMs = Math.max(
    0,
    Math.min(typeof cfg.minAttemptMs === 'number' && cfg.minAttemptMs >= 0 ? cfg.minAttemptMs : 2_000, attemptTimeoutMs),
  )

  /**
   * 单次尝试 = **一次受限评审 loop**（one-step-biased bounded loop）：
   * 一步直接判定是**默认路径**；缺关键事实时在一条消息里要一批只读工具、批量并行执行、一轮回灌，
   * 然后**优先收尾**。硬上限各自独立（4 步 / 3 批 / 8 次工具，见 verify.js 常量），
   * 到任一上限就带着现有证据收尾；拿不到判定即 fail-closed。
   * 超时取"单次上限"与"剩余总预算"里更小的那个。
   */
  const attemptOnce = async (attemptNo) => {
    const remaining = Math.max(1, deadline - now())
    const attemptBudgetMs = Math.max(1, Math.min(attemptTimeoutMs, remaining))
    const attemptDeadline = now() + attemptBudgetMs
    // 把这次尝试实际拿到的超时记进日志：不必依赖真实耗时就能核对"单次上限被总预算夹住"
    log?.write('review-attempt', { attempt: attemptNo, timeoutMs: attemptBudgetMs, remainingMs: remaining, attemptTimeoutMs, totalTimeoutMs })
    return runReviewLoop({
      ctx,
      exec,
      log,
      system,
      userText,
      toolsEnabled,
      deadline: attemptDeadline,
      now,
      callModel: async (prompt, user, timeoutMs) => {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, attemptDeadline - now())))
        const signal = exec?.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
        const stream = ctx.llm.stream({
          provider,
          model,
          system: prompt,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          temperature: 0,
          // 思考强度：留空＝交给 provider/模型默认（与 Composer 的"思考强度"同义）
          ...(effort === '' ? {} : { reasoningEffort: effort }),
          signal,
        })
        return readAssistantText(stream, BlockAssembler ?? undefined)
      },
    })
  }

  let attempt = 1
  let outcome
  for (;;) {
    try {
      outcome = await attemptOnce(attempt)
      if (attempt > 1) log?.write('review-succeeded-after-retry', { attempt })
      break
    } catch (error) {
      const message = String(error?.message ?? error)
      const remaining = deadline - now()
      // 区分三种"中止"：① 调用方取消（不重试）② 总预算耗尽（不重试）③ 本次尝试超时（**可以**重试）
      const callerAborted = exec?.signal?.aborted === true
      const totalExpired = now() >= deadline || remaining <= 0
      const attemptTimedOut = !callerAborted && !totalExpired && /timed out|timeout|aborted|abort/i.test(message)
      const retryable = isRecoverableReviewError(error) || attemptTimedOut
      if (attempt >= MAX_REVIEW_ATTEMPTS || !retryable || totalExpired) throw error
      const jitter = 0.9 + random() * 0.2
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
      await wait(delay)
      if (now() >= deadline) throw error
      attempt += 1
    }
  }

  // 单段 loop 跑完但仍没拿到判定：按"评审失败"处理（failMode 决定拒绝还是交回人工），
  // 绝不猜、绝不因为用了工具而放宽判定。工具输出了什么只进日志。
  if (outcome.decision === undefined) {
    const failure = new Error(
      outcome.info?.exhausted === 'budget'
        ? 'the review loop ran out of budget without a verdict'
        : 'the review loop did not produce a verdict',
    )
    failure.reviewerBackend = 'review'
    failure.verify = outcome.info
    throw failure
  }

  // 本次判定的授权版本（照 Codex GuardianAuthorizationVersion）：调用方按它给历史评审打标
  return { ...outcome.decision, authorizationVersion: snapshot.authorizationVersion, verify: outcome.info }
}
