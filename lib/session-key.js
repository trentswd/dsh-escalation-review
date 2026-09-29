/**
 * session-key.js —— 会话与 turn 的身份（从 index.js 抽出来，便于单测与复用）
 *
 * turn 的近似：**用户消息条数**。用户每说一句话就算一个新 turn，
 * 等价于 Codex 的 clear_turn / user_message_revision —— 熔断计数与"历史评审版本"都靠它。
 */

/** 会话标识：优先 session.id，退回 header.sessionId，最后用固定串兜底（绝不抛）。 */
export function sessionKeyOf(exec) {
  try {
    return String(exec?.agent?.session?.id ?? exec?.agent?.session?.header?.sessionId ?? 'session')
  } catch {
    return 'session'
  }
}

/** turn 标识：用户消息条数（解析失败一律算 0，绝不抛）。 */
export function turnIdOf(exec) {
  try {
    const events = exec?.agent?.session?.snapshotEvents?.() ?? []
    let count = 0
    if (Array.isArray(events)) {
      for (const event of events) {
        if (event?.type === 'user/message') count += 1
      }
    }
    return String(count)
  } catch {
    return '0'
  }
}