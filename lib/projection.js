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
    risk: z.string(),
    decision: z.string(),
    rationale: z.string(),
    reason: z.string(),
    at: z.number(),
  })
  const viewSchema = z.record(z.string(), verdictSchema)

  const stateSchema = z.object({
    revision: z.number(),
    view: z.record(z.string(), verdictSchema),
  })

  // 注册前自检：schema 必须真的能 parse —— 不满足就抛，让调用方跳过注册（历史优先）
  if (viewSchema === null || viewSchema === undefined || typeof viewSchema.parse !== 'function') {
    throw new Error('escalation-review: projection view schema is unusable (no parse); refusing to register')
  }

  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema,
    // 状态只需一个"已发布版本号"：内容本身每次从 store 现取（见 apply）
    init: () => ({ revision: 0, view: {} }),
    apply: (state, _event) => {
      // 未发生变化时必须返回**同一个引用**（官方契约：引用不变 = 零下游工作量）
      const revision = store.revision()
      if (revision === state.revision) return state
      return { revision, view: store.snapshot() }
    },
    wire: {
      viewSchema,
      view: (state) => (state !== null && state !== undefined && typeof state === 'object' ? state.view : {}),
    },
    // 保留字段供将来做严格校验（当前 viewSchema 宽松）
    _verdictSchema: verdictSchema,
  }
}

/**
 * 判定仓库：进程内、按 callId 索引。只保留最近 N 条，避免长会话无限增长。
 * @param {number} limit - 最多保留多少条（默认 200）
 */
export function createVerdictStore(limit = 200) {
  /** @type {Map<string, object>} */
  const byCallId = new Map()
  let revision = 0
  return {
    /** 记一次评审结果；callId 缺失时忽略（无法与卡片关联）。 */
    remember(callId, verdict) {
      if (typeof callId !== 'string' || callId.length === 0) return
      const entry = {
        risk: String(verdict?.risk ?? 'unknown'),
        decision: String(verdict?.decision ?? 'unknown'),
        rationale: typeof verdict?.rationale === 'string' ? verdict.rationale : '',
        reason: typeof verdict?.reason === 'string' ? verdict.reason : '',
        at: Date.now(),
      }
      byCallId.set(callId, entry)
      while (byCallId.size > limit) {
        const oldest = byCallId.keys().next()
        if (oldest.done === true) break
        byCallId.delete(oldest.value)
      }
      revision += 1
    },
    /** 单调递增的版本号：投影据此判断"有没有新东西"。 */
    revision() {
      return revision
    },
    /** 客户端可见的纯数据快照（每次都新建对象，避免与 React 引用比较打架）。 */
    snapshot() {
      const out = {}
      for (const [callId, entry] of byCallId) out[callId] = { ...entry }
      return out
    },
    /** 诊断用 */
    size() {
      return byCallId.size
    },
  }
}
