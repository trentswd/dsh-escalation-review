/**
 * breaker.js —— 连续拒绝熔断（照抄 Codex `ext/guardian-reviewer/src/circuit_breaker.rs`）
 *
 * 为什么要它：评审器不停拒绝会把整个任务卡死。Codex 的做法是按 **turn** 计数：
 *   · consecutive_denials 连续拒绝数；recent_denials 为长度 50 的窗口
 *   · 标准档阈值：连续 ≥ 3 或窗口内 ≥ 10 → 触发一次 "interrupt"（`interrupt_triggered` 只触发一次）
 *   · 任何非拒绝（allow / 交回人工之外的正常通过）把连续计数清零
 *
 * 我们这边没有"打断 turn"的权限，等价动作是：**停止拒绝，改为交回人工（ask）**，
 * 并写一条 `circuit-breaker` 日志——任务不再被无限卡住，人仍然在场。
 */
export const MAX_CONSECUTIVE_DENIALS = 3
export const MAX_RECENT_DENIALS = 10
export const DENIAL_WINDOW_SIZE = 50

/** 每个会话一条记录；turnId 变化即视为新 turn（与 Codex 的 clear_turn 等价）。 */
const sessions = new Map()

function bucketFor(sessionKey, turnId) {
  const key = String(sessionKey ?? 'unknown')
  let bucket = sessions.get(key)
  if (bucket === undefined || bucket.turnId !== turnId) {
    bucket = { turnId, consecutive: 0, recent: [], interruptTriggered: false }
    sessions.set(key, bucket)
  }
  return bucket
}

/**
 * 记一次"拒绝"（deny 或 ask 都算评审器没有放行）。
 * @returns {{ interrupt: boolean, consecutive: number, recent: number }}
 */
export function recordDenial(sessionKey, turnId, limits = {}) {
  const maxConsecutive = limits.maxConsecutive ?? MAX_CONSECUTIVE_DENIALS
  const maxRecent = limits.maxRecent ?? MAX_RECENT_DENIALS
  const bucket = bucketFor(sessionKey, turnId)
  bucket.consecutive += 1
  bucket.recent.push(true)
  if (bucket.recent.length > DENIAL_WINDOW_SIZE) bucket.recent.shift()
  const recent = bucket.recent.filter(Boolean).length
  if (!bucket.interruptTriggered && (bucket.consecutive >= maxConsecutive || recent >= maxRecent)) {
    bucket.interruptTriggered = true
    return { interrupt: true, consecutive: bucket.consecutive, recent }
  }
  return { interrupt: false, consecutive: bucket.consecutive, recent }
}

/** 记一次"没有拒绝"（评审通过或未介入）→ 连续计数清零。 */
export function recordNonDenial(sessionKey, turnId) {
  const bucket = bucketFor(sessionKey, turnId)
  bucket.consecutive = 0
  bucket.recent.push(false)
  if (bucket.recent.length > DENIAL_WINDOW_SIZE) bucket.recent.shift()
}

/** 会话结束时清掉（对应 Codex 的 clear_turn）。 */
export function clearSession(sessionKey) {
  sessions.delete(String(sessionKey ?? 'unknown'))
}

/** 诊断用：读当前计数。 */
export function peek(sessionKey) {
  const bucket = sessions.get(String(sessionKey ?? 'unknown'))
  if (bucket === undefined) return undefined
  return {
    turnId: bucket.turnId,
    consecutive: bucket.consecutive,
    recent: bucket.recent.filter(Boolean).length,
    interruptTriggered: bucket.interruptTriggered,
  }
}

/** 诊断用：整体重置。 */
export function resetAll() {
  sessions.clear()
}
