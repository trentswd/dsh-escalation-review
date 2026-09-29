/**
 * escalation-review —— 只审「沙箱越界」的 LLM reviewer
 *
 * 目标形状：
 *   - 沙箱照旧（workspace-write），**只有需要越界的调用**才审 → 项目内操作零额外模型调用
 *   - 不记忆授权：每次越界重审（"用户说过允许"靠上下文证据命中，不靠缓存）
 *   - 评审失败/超时 → 默认**直接拒绝**（fail-closed），文案与「政策拒绝」可区分
 *   - 拒绝理由对模型可见（info.reason），可据此决定绕过 / 重试 / 停下来问人
 *   - **控制面在配置页里**（改动自动保存，落 profile 的 `cordis.patch.yml`），文件层作兜底；
 *     每次越界时重读生效配置，改完约 2 秒生效、不用重启
 *
 * 架构参考：
 *   - DSH `@deepseek-ai/dsh-experimental-auto-review`：`tools/pre-execute` 返回三态决策对象
 *     （deny / ask / 放行）、严格 JSON 协议、`BlockAssembler` 消费 LLM 流、失败即拒
 *   - Codex `codex-rs/core/src/guardian/`：只挂在 approval 路径上、完整 transcript（声明为
 *     不可信证据）+「保留的用户指令」授权段 + 护栏（截断的证据 ≠ 完整授权）
 *
 * 实现要点：
 *   - 触发条件与 `dsh-tool-bash` 完全对齐：`args.sandbox_permissions` 存在且 ≠ 生效模式
 *   - 放行时把 (session, callId) 记入内存表，由同插件的 `approval/request` answerer 消费，
 *     使工具自身的 `approveEscalation` 直接拿到 `allowed-once` —— 用户不会被二次询问
 *   - 拒绝时**在工具体执行前**返回决策对象，因此文案完全由本插件控制
 *   - 模块划分（见各自文件头）：`config`（配置控制面）/ `policy`（证据塑形与决策解析，纯函数）/
 *     `reviewer`（LLM 流水线，含 BlockAssembler 懒加载）/ `config-schema`（DSH 的 `Config`）/
 *     `client`（配置页与 provider/model 选择器）/ `selftest` / `dsh-packages`（link 安装的模块解析）
 *   - 本文件只负责控制流：钩子接线、介入开关门控、审批记账、日志、以及对外导出的公共面
 *   - **自带加载链诊断**：module-imported / apply-called / services-ready / ready 四道痕迹
 *     写在 $DSH_HOME/escalation-review.log，用来定位"到底哪一环没跑到"
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { importDshPackage, importSchema } from './dsh-packages.js'
import { buildSchema } from './config-schema.js'
import { loadSelfTest } from './selftest-loader.js'
import { BOOT_LOG, DEFAULT_CONFIG, PACKAGE_DIR, parseConfigText, resolveConfig, sanitize } from './config.js'
import { assemblerSourceName, review, setAssemblerOverride } from './reviewer.js'
import { buildPolicy, buildSnapshot, extractJsonText, isEscalation, parseDecision, readDecision, renderSnapshot, safeCall, textOf, truncate } from './policy.js'
import { recordDenial, recordNonDenial } from './breaker.js'
import { createProjectionDefinition, createVerdictStore } from './projection.js'

// 判定仓库：进程内按 callId 索引，供客户端投影读取（放行那次的理由没有事件通道，只能这样送）
const verdictStore = createVerdictStore()
import { sessionKeyOf, turnIdOf } from './session-key.js'
import { circuitBreakerAction, reviewFailureAction, reviewRejectedAction } from './decisions.js'


// 公共面保持稳定：调用方从 index.js 取这些纯函数
export { buildPolicy, buildSnapshot, extractJsonText, isEscalation, parseDecision, readDecision, renderSnapshot, textOf, truncate }

// 上一次写进日志的"生效 mode"：ready 行给的是 apply 时刻的兜底值（实测误导），
// 所以在真正拿到调用期配置时如实报告
let loggedEffectiveMode = null

export const name = 'escalation-review'

// 公共面保持稳定：调用方从 index.js 取这两个纯函数
export { parseConfigText, resolveConfig }

/**
 * 导出一个 schemastery `Config` —— 这是 0.1.7 里"让插件出现在设置/插件页并有表单"的**唯一正道**：
 * 运行时的 settings 服务是 `SettingsForms`，它的类注释就写着 "Project `Config` schemas into forms"；
 * `SettingsForms.schema(entry)` 的真实取法是 `entry.fiber.runtime.Config`，
 * 而 cordis 里 `runtime = { …, Config: plugin.Config }`。
 * 表单写回的是该条目的 `config` → 会作为 `apply(ctx, config)` 的第二参传回来。
 *
 * ⚠️ 关键（2026-09-27 实测定位）：**必须用异步 `import()` 取 schemastery，不能用 `require()`** ——
 * app 跑在 Electron 主进程里，`require(ESM)` 会失败 ✗（异步 import 才是**已验证可行**的路径：
 * 宿主装配器就是这么加载 `@deepseek-ai/dsh-llm` 的 ✓）。这里用**顶层 await**：
 * loader 是 `await import(插件模块)` 加载的，TLA 安全 ✓。
 * 之前用 `require()` 的版本在 app 里静默拿到 `undefined` → 命名空间不被服务 → 配置页永远不出现。
 */
let schemaBuilder
// 投影的 wire.viewSchema 必须是 **zod**（官方 ZodType），不是 schemastery
let zodBuilder
try {
  const loaded = await importDshPackage('zod')
  zodBuilder = loaded?.z ?? loaded?.default?.z ?? loaded
} catch (error) {
  zodBuilder = undefined
  // 拿不到 zod 就不注册投影（历史优先，见下面的自检）
}
try {
  schemaBuilder = await importSchema()
} catch (error) {
  // 此刻 bootLog 依赖的模块级常量还没初始化（TDZ）→ 直接裸写日志文件，避免"错误被吞掉"
  try {
    const home =
      typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
    appendFileSync(
      join(home, 'escalation-review.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), event: 'config-schema-unavailable', message: String(error?.message ?? error), attempts: error?.attempts })}\n`,
    )
  } catch {
    /* 日志写不了也不能影响插件 */
  }
}

export const Config = schemaBuilder === undefined ? undefined : buildSchema(schemaBuilder)

// 不用声明式 inject 门控：某个服务缺失时 apply 会静默不跑（最难排查的失败模式）。
// 改成在 apply 内部动态注入，这样至少能留下痕迹。
export const inject = []

const DENIED_NAME = 'EscalationReviewDeniedError'
const DENIED_CODE = 'ESCALATION_REVIEW_DENIED'

function bootLog(event, detail = {}) {
  try {
    appendFileSync(BOOT_LOG, `${JSON.stringify({ ts: new Date().toISOString(), event, pid: process.pid, ...detail })}\n`)
  } catch {
    /* 诊断痕迹写不进去也不能影响宿主 */
  }
}

bootLog('module-imported', { node: process.version, dir: PACKAGE_DIR })

// Config 自检：放在这里（而不是 Config 定义处）是因为那一刻 bootLog 依赖的常量还没初始化（TDZ）。
// 这一行 + `settings-probe.mine` 就能判定"命名空间有没有被服务"。
bootLog('config-export-check', {
  type: typeof Config,
  fields: Config !== undefined && Config !== null && Config.dict !== undefined ? Object.keys(Config.dict).length : null,
})


// ─────────────────────────────────────────────────────────────── 运行时部分

function effectiveMode(ctx, exec) {
  const resolved = safeCall(() => ctx.get?.('sandboxPolicy')?.resolve?.({ session: exec?.agent?.session }))
  const mode = resolved?.mode
  return typeof mode === 'string' ? mode : undefined
}

function rememberApproval(store, session, callId) {
  if (session === undefined || session === null) return
  let bucket = store.get(session)
  if (bucket === undefined) {
    bucket = []
    store.set(session, bucket)
  }
  bucket.push({ callId, at: Date.now() })
  if (bucket.length > 32) bucket.splice(0, bucket.length - 32)
}

function consumeApproval(store, session, callId, windowMs) {
  if (session === undefined || session === null) return false
  const bucket = store.get(session)
  if (bucket === undefined || bucket.length === 0) return false
  const now = Date.now()
  for (let i = bucket.length - 1; i >= 0; i -= 1) {
    const entry = bucket[i]
    if (now - entry.at > windowMs) continue
    if (callId !== undefined && entry.callId !== undefined && entry.callId !== callId) continue
    bucket.splice(i, 1)
    return true
  }
  return false
}



function makeLog(ctx) {
  let live = { ...DEFAULT_CONFIG, logPath: BOOT_LOG }
  return {
    setConfig(cfg) {
      live = cfg
    },
    write(event, detail = {}) {
      const line = { ts: new Date().toISOString(), event, mode: live.mode, ...detail }
      try {
        appendFileSync(live.logPath, `${JSON.stringify(line)}\n`)
      } catch {
        /* 记录失败不影响判定 */
      }
      try {
        ctx?.logger?.info?.('[escalation-review]', event, detail)
      } catch {
        /* 宿主无 logger 就算了 */
      }
    },
  }
}

let selfTestStarted = false
let schemaBuilderOverride // 诊断用：注入替代的 schemastery

export function apply(ctx, config) {
  const base = config ?? {}
  bootLog('apply-called', { configKeys: Object.keys(base) })
  const log = makeLog(ctx)

  // 文件层：每次越界重读（loadedConfigFiles / configErrors 只存在于这一层）
  const fromFiles = () => resolveConfig(base)

  /**
   * Host 设置的「用户覆盖层」= 配置页保存的那一层。
   *
   * ⚠️ 为什么不直接用 `apply(ctx, config)`：实测（2026-09-27）**profile patch 里同 id 的
   * `config:` 不会被合并进"由 bundle patch 插入"的那个条目** —— 保存成功了（patch 里能看到
   * `mode: enforce`），但重启后 apply 拿到的 config 仍是 schema 默认值。
   * 所以这里直接读 `settings.describe()` 里该命名空间的 **user 层**（表单写的就是它），
   * 定时刷新（2s）→ 保存后即时生效，**无需重启**。
   */
  let hostUser = {}
  let hostUserReady = false
  const refreshHostUser = () => {
    try {
      const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
      if (settings === undefined || typeof settings.describe !== 'function') return
      Promise.resolve(settings.describe())
        .then((value) => {
          const list = Array.isArray(value) ? value : (value?.namespaces ?? [])
          const descriptor = Array.isArray(list)
            ? list.find((item) => (item?.ns ?? item?.namespace ?? item?.id) === 'escalation-review')
            : undefined
          hostUser = sanitize(descriptor?.user ?? {})
          if (!hostUserReady) {
            hostUserReady = true
            log.write('host-user-loaded', {
              keys: Object.keys(hostUser),
              mode: hostUser.mode ?? null,
              descriptorKeys: descriptor === undefined ? null : Object.keys(descriptor),
            })
          }
        })
        .catch(() => {
          /* 读不到就沿用文件层 */
        })
    } catch {
      /* 读不到就沿用文件层 */
    }
  }
  refreshHostUser()
  const hostTimer = setInterval(refreshHostUser, 2000)
  if (typeof hostTimer?.unref === 'function') hostTimer.unref()

  // 生效配置 = 文件层 ← Host 用户覆盖层（最高优先级，且保存后 ~2s 内自动生效）。
  // 归一化 logPath：空字符串会把默认值覆盖成空 → 日志静默写不进去（踩过）。
  const effective = () => {
    const merged = { ...fromFiles(), ...hostUser }
    if (typeof merged.logPath !== 'string' || merged.logPath.length === 0) merged.logPath = BOOT_LOG
    return merged
  }

  let live
  try {
    live = effective()
  } catch (error) {
    bootLog('config-failed', { message: String(error?.message ?? error) })
    live = { ...DEFAULT_CONFIG, logPath: BOOT_LOG }
  }
  log.setConfig(live)
  const approvals = new WeakMap()
  const refresh = () => {
    live = effective()
    log.setConfig(live)
    return live
  }

  const SERVICES = ['approval', 'llm', 'sessions', 'tools']
  // 兼容起见：ctx.inject 不存在时直接注册（宿主夹具与旧版 cordis 都能跑）
  const inject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : (_deps, cb) => cb(ctx)

  /**
   * 介入开关（2026-09-28 起）：**不再依赖会话预设**，改由插件自己的配置项 `enabled` 决定，
   * 因此与 profile / 权限预设表完全解耦 —— 打开后就接管**所有**沙箱越界的审批。
   * 默认 false（零介入）；`mode: observe` 只评审不动手，`mode: enforce` 才替用户答审批。
   */
  // 历史评审环形缓冲（每会话最多 8 条，照 Codex MAX_PREVIOUS_REVIEWS）：让同类动作判例一致；
  // 带上 turnId（= 用户消息版本），便于判定"是否早于当前指令"
  const RECENT_REVIEW_LIMIT = 8
  const recentReviews = new Map()
  const recordReview = (sessionKey, turnId, entry) => {
    try {
      const bucket = recentReviews.get(sessionKey) ?? []
      bucket.push({ turnId, ...entry })
      if (bucket.length > RECENT_REVIEW_LIMIT) bucket.splice(0, bucket.length - RECENT_REVIEW_LIMIT)
      recentReviews.set(sessionKey, bucket)
    } catch {
      /* 记录失败不影响评审 */
    }
  }
  try {
    inject(SERVICES, (scoped) => {
      bootLog('services-ready', { services: SERVICES })
      log.write('services-ready', { hasEffect: typeof scoped?.effect, hasOn: typeof scoped?.on })
      scoped.effect(function* run() {
        log.write('effect-started')
        // 客户端可见的投影：域侧保留判定与理由，客户端读 projectionValues['escalation-review']。
        // 用作用域注入等 sessionProjections（可选服务；声明式注入会让 entry 挂住）。
        try {
          if (zodBuilder !== undefined && zodBuilder !== null && typeof zodBuilder.record === 'function') {
            scoped.inject(['sessionProjections'], (projectionScope) => {
              try {
                // createProjectionDefinition 内部会自检 viewSchema.parse 是函数，不满足就抛 → 不注册
                projectionScope.effect(
                  () => projectionScope.sessionProjections.register(createProjectionDefinition({ z: zodBuilder, store: verdictStore })),
                  'escalation-review: review verdict projection',
                )
                log.write('projection-registered', { key: 'escalation-review', schema: 'zod' })
              } catch (error) {
                log.write('projection-register-failed', { message: String(error?.message ?? error) })
              }
            })
          } else {
            log.write('projection-skipped', { note: 'zod unavailable' })
          }
        } catch (error) {
          log.write('projection-register-failed', { message: String(error?.message ?? error) })
        }

        log.write('intervention-gate', { enabled: live.enabled === true, mode: live.mode, note: 'apply-time snapshot; the effective gate is read per call' })
    log.write('ready', {
          mode: live.mode,
          timeoutMs: live.timeoutMs,
          failMode: live.failMode,
          denyMode: live.denyMode,
          hosts: live.allowedHosts.length,
          logPath: live.logPath,
          assemblerSource: assemblerSourceName(),
          configFiles: live.loadedConfigFiles,
          configErrors: live.configErrors,
        })

        // 配置表单：宿主根据上面导出的 `Config` 自动投影；客户端半边（lib/client.js）用
        // `ctx.configForms.whileServed(['escalation-review'])` 注册页面 —— 前提是 Host 真的把
        // 这个条目当作"被服务的设置命名空间"暴露出来。下面这条探针只为把这件事变成可见的日志。


        // 1) 越界调用：评审 → 放行 / 拒绝（工具体不会执行）
        yield scoped.on(
          'tools/pre-execute',
          async (exec, next) => {
            const cfg = refresh()
        // 生效配置可追溯（2026-09-28）：ready 行的 mode 是 apply 时刻的兜底值，别拿它当真相
        if (loggedEffectiveMode !== cfg.mode) {
          log.write('config-effective', { from: loggedEffectiveMode, to: cfg.mode, note: 'call-time read (settings layer)' })
          loggedEffectiveMode = cfg.mode
        }
            const args = exec?.arguments
            const effective = effectiveMode(scoped, exec)
            if (!isEscalation(args, effective)) return next()
            // 介入判定只由插件自己的配置开关（enabled）决定，与权限预设完全解耦：
            //    关闭时 = 零介入 + 零模型调用；打开后接管**所有**沙箱越界的审批。
            // 介入判定：只由插件的配置开关决定（与权限预设无关）
            const switchOn = cfg.enabled === true
            if (!switchOn) return next()
            // 打开后：mode=enforce → 替用户回答审批；mode=observe → 只评审记录、不动手
            const gated = cfg.mode === 'enforce'
            // 会话/turn 标识：turn 用"用户消息条数"近似（用户一说话就算新 turn，等价 Codex 的 clear_turn）
            const sessionKey = sessionKeyOf(exec)
            const turnId = turnIdOf(exec)
            const started = Date.now()
            let decision
            try {
              // 版本筛选归 policy（它才知道当前证据是否完整）；这里只把原料交出去
              decision = await review(scoped, exec, cfg, log, effective, {
                previousReviews: recentReviews.get(sessionKey) ?? [],
                turnId,
              })
            } catch (error) {
              const message = String(error?.message ?? error)
              log.write('reviewer-failed', { mode: cfg.mode,
                tool: exec?.name,
                callId: exec?.callId,
                requested: args?.sandbox_permissions,
                effective,
                ms: Date.now() - started,
                message,
              })
              const failure = reviewFailureAction({
                gated,
                cfg,
                exec,
                message,
                deniedName: DENIED_NAME,
                deniedCode: DENIED_CODE,
              })
              if (failure.kind === 'pass') return next()
              return failure
            }
            log.write('reviewed', { mode: cfg.mode,
              tool: exec?.name,
              callId: exec?.callId,
              enabled: cfg.enabled === true,
              requested: args?.sandbox_permissions,
              effective,
              ms: Date.now() - started,
              risk: decision.risk,
              decision: decision.decision,
              reason: decision.reason,
              rationale: decision.rationale,
            })
            if (cfg.selfTest === true && !selfTestStarted) {
              // 用例是可选的附加模块，默认未安装：取不到就记 selftest-unavailable，只尝试一次，不影响评审
              selfTestStarted = true
              try {
                const selfTest = await loadSelfTest(cfg)
                // 伪造动作自测：不 await（免得拖慢这次真实调用），失败只记录
                log.write('selftest-start', { baseCases: selfTest.SELFTEST_CASES?.length, via: exec?.name })
                void selfTest.runSelfTest({ review, ctx: scoped, exec, cfg, log, effective }).catch((error) =>
                  log.write('selftest-error', { message: String(error?.message ?? error) }),
                )
              } catch (error) {
                log.write('selftest-unavailable', { attempts: error?.attempts })
              }
            }
            // 送客户端的判定与理由（客户端卡片按 callId 读投影）
            verdictStore.remember(exec?.callId, {
              risk: decision.risk,
              decision: decision.decision,
              rationale: decision.rationale,
              reason: decision.reason,
            })
            recordReview(sessionKey, turnId, {
              // 版本元组照 Codex：用户消息版本 + 证据是否完整；两者都相等才可复用
              authorizationVersion: decision.authorizationVersion ?? { turn: turnId, complete: false },
              completedAt: new Date().toISOString(),
              tool: exec?.name,
              risk: decision.risk,
              authorization: decision.authorization,
              outcome: decision.decision,
              reason: typeof decision.reason === 'string' ? decision.reason.slice(0, 200) : undefined,
              callId: exec?.callId,
            })
            if (decision.decision === 'allow') {
              recordNonDenial(sessionKey, turnId)
              if (gated) {
                rememberApproval(approvals, exec?.agent?.session, exec?.callId)
                // ⚠️ 审批瀑布是从 **agent 的上下文** 开始收集 answerer 的
                //（dsh-user-approval：`ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', …)`），
                // 所以在自己 scoped ctx 上注册的监听器**根本不会被扫到** → 每次都问用户。
                // 这里按 agent 挂一个**一次性** answerer：只回答这一次越界调用，答完即注销。
                try {
                  const agentCtx = exec?.agent?.ctx ?? exec?.agent?.context ?? null
                  if (agentCtx !== null && typeof agentCtx.on === 'function') {
                    const callId = exec?.callId
                    const dispose = agentCtx.on(
                      'approval/request',
                      async (req, down) => {
                        if (req?.callId !== callId) return down()
                        try {
                          if (typeof dispose === 'function') dispose()
                        } catch {
                          /* 注销失败不影响放行 */
                        }
                        // ⚠️ 2026-09-28 实测结论：往 req.reason 里并判定与理由是**无效**的 —— 官方
                        //   user-approval 先 `session.append('approval/asked', …)` 再 await decide()，
                        //   所以那条事件早已落盘，我改的只是内存对象（日志里一度出现 approval-reason-enriched，
                        //   但它并不代表进了日志；实测会话里 approval/asked.reason 没有我的后缀）。
                        //   放行那次的"评审理由"因此没有事件通道，要显示它只能走 typert Remote。
                        log.write('approval-granted', { mode: cfg.mode, via: 'agent', tool: req?.toolName, callId })
                        return 'allowed-once'
                      },
                      { prepend: true },
                    )
                    log.write('approval-scope-registered', { via: 'agent.ctx', callId })
                  } else {
                    log.write('approval-scope-missing', {
                      agentKeys: exec?.agent === undefined || exec?.agent === null ? null : Object.keys(exec.agent),
                    })
                  }
                } catch (error) {
                  log.write('approval-scope-error', { message: String(error?.message ?? error) })
                }
              }
              return next()
            }
            if (!gated) return next()
            // 连续拒绝熔断（照 Codex circuit_breaker.rs：连续 3 次 / 窗口内 10 次）：
            // 触发后不再拒绝，改为交回人工，避免把整个任务卡死。
            const breaker = recordDenial(sessionKey, turnId)
            if (breaker.interrupt) {
              log.write('circuit-breaker', {
                session: sessionKey,
                turn: turnId,
                consecutive: breaker.consecutive,
                recent: breaker.recent,
              })
              return circuitBreakerAction({ exec, breaker })
            }
            return reviewRejectedAction({ cfg, exec, decision, deniedName: DENIED_NAME, deniedCode: DENIED_CODE })
          },
          { prepend: true },
        )

        // 2) 审批缝：只放行「本插件刚批准过的那一次越界」，其余全部交给下游（人工）
        yield scoped.on('approval/request', async (req, next) => {
          try {
            if (live.enabled === true && live.mode === 'enforce' && consumeApproval(approvals, req?.agent?.session, req?.callId, live.timeoutMs)) {
              log.write('approval-granted', { mode: live.mode, tool: req?.toolName, callId: req?.callId, reason: req?.reason })
              return 'allowed-once'
            }
          } catch (error) {
            log.write('approval-error', { message: String(error?.message ?? error) })
          }
          return next()
        })
      })
    })
  } catch (error) {
    bootLog('inject-failed', { message: String(error?.message ?? error) })
    log.write('inject-failed', { message: String(error?.message ?? error) })
  }
}

/**
 * ⚠️ 官方形态（2026-09-27 读官方包 `dsh-pwsh-sandbox` 确认）：
 *     `var X = class X extends 基类 { static inject = […] }`
 *     `export { X, X as default }`
 * —— **class + `static Config` + default 导出**是官方宿主半边统一的做法，
 * 而 cordis 的 `runtime.Config` 取自 `plugin.Config`（`ctx.plugin()` 源码），对构造函数还有专门分支：
 *     `if (isConstructor(runtime.callback)) { const instance = new runtime.callback(this.ctx, this.config) … }`
 *
 * 本插件的实现仍是 `apply(ctx, config)`，这里只加一个类壳把 `Config` 变成**类的静态属性**，
 * 让任何加载路径（default 导出 / 命名空间 / 类）都能取到它。实现逻辑一行未改。
 */
class EscalationReview {
  static Config = Config
  static inject = []
  constructor(ctx, config) {
    apply(ctx, config)
  }
}

export { EscalationReview }
export default EscalationReview

/** 诊断接口：供宿主与调用方取用内部状态。 */
export const __diagnostics = {
  effectiveMode,
  rememberApproval,
  consumeApproval,
  review,
  BOOT_LOG,
  setAssembler(value) {
      setAssemblerOverride(value)
    },
  setSchemaBuilder(value) {
    schemaBuilderOverride = value
  },
}