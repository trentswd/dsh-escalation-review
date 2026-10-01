/**
 * projection.js —— 把"每次提权的评审判定与理由"送到客户端卡片。
 *
 * 为什么需要它：放行那次的评审理由**没有事件通道** —— 官方 `user-approval` 是先
 * `session.append('approval/asked', …)` 再 await decide()，所以往 `req.reason` 里追加
 * 判定根本进不了会话日志（2026-09-28 实测确认）。而会话事件又写不了自定义类型
 * （第三方插件拿不到 `ignorable` 标记）。官方为此准备的通道就是 `sessionProjections`：
 * 域侧保留状态、客户端直接读 `projectionValues`（官方 `agent-preset` 就是这么用的）。
 *
 * ⚠️ 诚实说明：`wire.view` 里的判定来自**本插件的内存表**，不是从日志重放出来的。
 *    因此它能反映**本次运行**里发生的评审；重载会话后旧调用只剩工具结果派生出的状态，
 *    理由会消失（不会出错，只是退化）。这一点与"投影应当可重放"的常规要求不一致，
 *    是有意的取舍：不然就得把整条 typert Remote 通道铺起来。
 */

/** 客户端读这个键：`session.projectionValues['escalation-review']`。 */
export const PROJECTION_KEY = 'escalation-review'

/**
 * **保留哨兵键**：把宿主读到的"总开关状态"随投影送到客户端。
 *
 * 为什么需要它：`enabled` 是 `.hidden()` 的，实测客户端从 `SettingsFormModel` 与
 * `configForms` 的三层**都读不到**（卡片诊断显示 `sw=null`），于是整个评审长窗口只能显示中性文案。
 * 与其让客户端猜，不如让**宿主**把它知道的事实放进投影 —— 客户端在 `tool/call` 那一刻就能读到。
 *
 * 为什么用哨兵键而不是给 view 加顶层字段：`viewSchema` 是 `z.record(z.string(), verdictSchema)`，
 * 顶层加标量会**校验失败**（注册表拒绝 → 整个会话历史加载不出来，这个坑踩过）。哨兵条目符合
 * 既有 value 形状，零 schema 变更、零客户端读取路径变更。callId 形如 `chatcmpl-tool-…`，不会撞。
 */
export const GATE_ENTRY_KEY = '$gate'

/**
 * 建立投影定义。`stateSchema`/`viewSchema` 用宿主自带的 schemastery（`z`）构建，
 * 形状保持宽松（键是 callId，值是判定对象）—— 校验失败会被注册表拒绝，所以宁可宽。
 * @param {object} input - { z, store }
 * @returns {object} ProjectionDefinition
 */
export function createProjectionDefinition({ z, store }) {
  // ⚠️ 这里必须是 **zod**（官方类型：`viewSchema: ZodType<…>`，session-projection/src/index.ts:75；
  //    gateway 第 466 行直接调 `wire.viewSchema.parse(...)`）。踩过的两个坑：
  //    ① 先用 schemastery 的 z.any() —— 产出物没有 .parse → 每次投影会话都抛
  //       "failed to project session … is not a function"，**整个会话历史加载不出来**；
  //    ② 换成 schemastery 的 z.dict(z.object(...)) 同样没有 .parse。
  //    zod 4 的 record 签名是 z.record(keyType, valueType)。
  const verdictSchema = z.object({
    status: z.string(),
    risk: z.string(),
    decision: z.string(),
    rationale: z.string(),
    reason: z.string(),
    at: z.number(),
  })
  const viewSchema = z.record(z.string(), verdictSchema)

  const stateSchema = z.object({
    // 本会话的键：投影状态必须知道自己属于哪个会话，才能只暴露自己的判定桶
    sessionKey: z.string(),
    revision: z.number(),
    // 宿主读到的总开关状态（null = 未知）：它变化时必须让投影重新折叠，否则客户端永远读不到
    gate: z.union([z.boolean(), z.null()]),
    view: z.record(z.string(), verdictSchema),
  })

  // 注册前自检：schema 必须真的能 parse —— 不满足就抛，让调用方跳过注册（历史优先）
  if (viewSchema === null || viewSchema === undefined || typeof viewSchema.parse !== 'function') {
    throw new Error('escalation-review: projection view schema is unusable (no parse); refusing to register')
  }

  /**
   * 哨兵条目：形状必须满足 verdictSchema（全部字段都在）。
   * ⚠️ 第七轮 R3/R4：总开关只是**配置事实**，不足以判定"这次调用会被接管"。把判定所需的
   *    会话/策略事实一并送过去（复用既有字段，零 schema 变更）：
   *      risk      = 本会话生效的沙箱档（客户端据此套用宿主的 isEscalation：requested !== effective）
   *      decision  = 运行模式（enforce / observe）
   *      rationale = 开关**变成当前值**的时刻（毫秒字符串）—— 更早的历史调用不得声称被接管
   *      reason    = 是否会自动代答（'auto' / 'ask'）—— 交回人工时卡片要说「待审批」
   */
  const gateEntry = (on, policy) => ({
    status: on ? 'on' : 'off',
    risk: String(policy?.effective ?? ''),
    decision: String(policy?.mode ?? ''),
    rationale: policy?.since === undefined || policy.since === null ? '' : String(policy.since),
    reason: policy?.autoAnswer === true ? 'auto' : policy?.autoAnswer === false ? 'ask' : '',
    at: 0,
  })

  return {
    key: PROJECTION_KEY,
    // state 形状变了（新增 gate / policy）→ 版本递增，持久化的旧行会按新形状重新折叠。
    stateVersion: 5,
    stateSchema,
    // `init(header, inheritedEventCount)` 是官方唯一把**会话身份**交给投影的地方（apply 只拿到事件）。
    // 拿不到 header 就落到空键：那个桶只会看到自己，绝不会和别人混。
    init: (header) => ({ sessionKey: String(header?.id ?? ''), revision: 0, gate: null, policy: null, view: {} }),
    apply: (state, _event) => {
      // 未发生变化时必须返回**同一个引用**（官方契约：引用不变 = 零下游工作量）
      const current = state === null || state === undefined || typeof state !== 'object'
        ? { sessionKey: '', revision: 0, gate: null, policy: null }
        : state
      const revision = store.revision(current.sessionKey)
      const gate = typeof store.gate === 'function' ? store.gate() : null
      const policy = typeof store.policy === 'function' ? store.policy() : null
      // 策略事实（生效档/模式/是否自动代答/开关时刻）也必须参与"要不要重算"的判定
      const samePolicy = JSON.stringify(policy ?? null) === JSON.stringify(current.policy ?? null)
      if (revision === current.revision && gate === current.gate && samePolicy) return state
      return { sessionKey: current.sessionKey, revision, gate, policy, view: store.snapshot(current.sessionKey) }
    },
    wire: {
      viewSchema,
      view: (state) => {
        const base = state !== null && state !== undefined && typeof state === 'object' && state.view !== null && typeof state.view === 'object'
          ? state.view
          : {}
        const gate = state !== null && state !== undefined && typeof state === 'object' ? state.gate : null
        const policy = state !== null && state !== undefined && typeof state === 'object' ? state.policy : null
        // 开关未知（null）时不写哨兵 —— 客户端据此保持中性文案（不许无证据声称在评审）
        if (gate !== true && gate !== false) return base
        return { ...base, [GATE_ENTRY_KEY]: gateEntry(gate, policy) }
      },
    },
    // 保留字段供将来做严格校验（当前 viewSchema 宽松）
    _verdictSchema: verdictSchema,
  }
}

/**
 * 判定仓库：进程内、**按会话分桶**（`Map<sessionKey, Map<callId, verdict>>`）。
 * 为什么不能全局按 callId 索引：两个会话可能撞同一个 callId，而且全局淘汰会删掉别的会话的条目；
 * 每个会话的投影只读自己的桶，revision 也按会话递增（无关会话互不 churn）。
 * @param {number} limit - 每个会话最多保留多少条（默认 200）
 */
export function createVerdictStore(limit = 200) {
  /** @type {Map<string, Map<string, object>>} */
  const bySession = new Map()
  /** @type {Map<string, number>} */
  const revisions = new Map()
  /** 宿主读到的总开关状态：`null` = 未知，`true`/`false` = 明确。 */
  let gateOn = null
  /** 会话/策略事实（第七轮 R3/R4）：生效沙箱档 / 运行模式 / 是否自动代答 / 开关变化时刻。 */
  let policyFacts = null

  const bucketOf = (sessionKey, create) => {
    const key = typeof sessionKey === 'string' ? sessionKey : ''
    let bucket = bySession.get(key)
    if (bucket === undefined && create === true) {
      bucket = new Map()
      bySession.set(key, bucket)
      if (!revisions.has(key)) revisions.set(key, 0)
    }
    return bucket
  }

  const entryOf = (verdict, status) => ({
    status,
    risk: String(verdict?.risk ?? 'unknown'),
    decision: String(verdict?.decision ?? 'unknown'),
    rationale: typeof verdict?.rationale === 'string' ? verdict.rationale : '',
    reason: typeof verdict?.reason === 'string' ? verdict.reason : '',
    at: Date.now(),
  })

  return {
    /** 评审开始前落一个"正在评审"的标记：卡片据此判断"这次调用确实被评审了"。 */
    mark(sessionKey, callId) {
      if (typeof callId !== 'string' || callId.length === 0) return
      const bucket = bucketOf(sessionKey, true)
      bucket.set(callId, entryOf({ risk: 'unknown', decision: 'reviewing' }, 'reviewing'))
      while (bucket.size > limit) {
        const oldest = bucket.keys().next()
        if (oldest.done === true) break
        bucket.delete(oldest.value)
      }
      const key = typeof sessionKey === 'string' ? sessionKey : ''
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
    },
    /** 记一次评审结果；callId 缺失时忽略（无法与卡片关联）。 */
    remember(sessionKey, callId, verdict) {
      if (typeof callId !== 'string' || callId.length === 0) return
      const bucket = bucketOf(sessionKey, true)
      bucket.set(callId, entryOf(verdict, 'settled'))
      while (bucket.size > limit) {
        const oldest = bucket.keys().next()
        if (oldest.done === true) break
        bucket.delete(oldest.value)
      }
      const key = typeof sessionKey === 'string' ? sessionKey : ''
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
    },
    /** 单调递增的**按会话**版本号：投影据此判断"这个会话有没有新东西"。 */
    revision(sessionKey) {
      return revisions.get(typeof sessionKey === 'string' ? sessionKey : '') ?? 0
    },
    /**
     * 宿主读到的总开关状态（`null` = 未知）。
     * ⚠️ 它必须参与"投影要不要重算"的判定（见 createProjectionDefinition 的 `apply`）——
     * 否则开关在评审前就已经是 true，客户端却因为 revision 没变而永远读不到。
     */
    gate() {
      return gateOn
    },
    /** 记录开关状态；**变化时**让所有已知会话的 revision 前进一步（触发投影重算）。 */
    setGate(value) {
      const next = value === true ? true : value === false ? false : null
      if (next === gateOn) return
      gateOn = next
      // 开关**变为当前值**的时刻：客户端据此拒绝把"更早的历史调用"说成被接管（第七轮 R3）
      policyFacts = { ...(policyFacts ?? { effective: '', mode: '', autoAnswer: null }), since: Date.now() }
      for (const key of revisions.keys()) revisions.set(key, (revisions.get(key) ?? 0) + 1)
    },
    /**
     * 会话/策略事实（第七轮 R3/R4）：生效沙箱档、运行模式、是否自动代答。
     * 总开关只是配置事实；"这次调用会不会被接管"要靠这些 + 每次调用的 requested 一起判定。
     */
    policy() {
      return policyFacts
    },
    /** 记录策略事实；**变化时**同样触发投影重算。 */
    setPolicy(facts) {
      const next = facts === null || facts === undefined
        ? null
        : {
            effective: facts.effective === undefined || facts.effective === null ? '' : String(facts.effective),
            mode: facts.mode === undefined || facts.mode === null ? '' : String(facts.mode),
            autoAnswer: facts.autoAnswer === true ? true : facts.autoAnswer === false ? false : null,
            since: typeof facts.since === 'number' ? facts.since : (policyFacts?.since ?? null),
          }
      if (JSON.stringify(next) === JSON.stringify(policyFacts)) return
      policyFacts = next
      for (const key of revisions.keys()) revisions.set(key, (revisions.get(key) ?? 0) + 1)
    },
    /** 某个会话可见的纯数据快照（每次都新建对象，避免与 React 引用比较打架）。 */
    snapshot(sessionKey) {
      const bucket = bucketOf(sessionKey, false)
      const out = {}
      if (bucket === undefined) return out
      for (const [callId, entry] of bucket) out[callId] = { ...entry }
      return out
    },
    /** 诊断用：某个会话（缺省=全部）的条目数。 */
    size(sessionKey) {
      if (typeof sessionKey === 'string') return bucketOf(sessionKey, false)?.size ?? 0
      let total = 0
      for (const bucket of bySession.values()) total += bucket.size
      return total
    },
  }
}
