/**
 * decisions.js —— `tools/pre-execute` 的动作构造（从 index.js 抽出的纯函数）
 *
 * 三态契约沿用 DSH：返回 `next()`（放行到下游）/ `{kind:'deny'|'ask'}`。
 * 抽出来的理由：这段文案与分支在 index.js 里连着被改了三轮（熔断、失败处理、denyMode），
 * 属于"每次都进的补丁点"；纯函数化之后可单测，index.js 只负责接线。
 *
 * 这里**不做任何 IO、不读配置**：所有输入由调用方给出，输出就是钩子该返回的对象。
 *
 * 文案语言（2026-09-27 定）：
 *   · **不提供 `displayReason`** —— 客户端的取值是 `displayReason ?? reason`，即 displayReason 优先；
 *     而官方那个字段是"由发起方提供译文"，本插件提供不了所有语言（只有 en/zh 会把日语用户也盖成中英）。
 *   · 本地化交给**模型**：策略里要求 reviewer 用"用户在本会话里使用的语言"写 reason/rationale。
 *   · 因此插件只加一个**语言中性**的 `escalation-review:` 前缀，可见内容主要是模型那段话。
 */

/**
 * 评审失败（异常/超时）的动作 —— fail-closed：只有显式 `failMode: 'ask'` 才交回人工。
 * @param {object} input - { gated, cfg, exec, message }
 */
export function reviewFailureAction({ gated, cfg, exec, message, deniedName, deniedCode }) {
  // 未启用「自动批准」时插件不介入，失败也不改变任何行为（零介入原则）
  if (!gated) return { kind: 'pass' }
  if (cfg.failMode === 'ask') {
    return {
      kind: 'ask',
      reason: `escalation-review: review failed (${message}) — your call`,
    }
  }
  return {
    kind: 'deny',
    reason: `escalation-review: review failed, body not executed — ${message}`,
    info: { name: deniedName, code: deniedCode, reason: message },
  }
}

/** 连续拒绝熔断后的动作：不再拒绝，交回人工（照 Codex circuit_breaker：避免把任务卡死）。 */
export function circuitBreakerAction({ exec, breaker }) {
  return {
    kind: 'ask',
    reason: `escalation-review: ${breaker.consecutive} consecutive denials — asking you instead of blocking`,
  }
}

/**
 * 评审给出拒绝时的动作：按 `denyMode` 决定拒绝还是交回人工。
 * （放行路径不在这里 —— 它还要向 agent 注册一次性审批 answerer，属于宿主接线。）
 * @param {object} input - { cfg, exec, decision, deniedName, deniedCode }
 */
export function reviewRejectedAction({ cfg, exec, decision, deniedName, deniedCode }) {
  const hasReason = decision?.reason !== undefined && decision.reason !== null
  // 分层（2026-09-28 按用户口径定）：评审器判 allow/deny/ask，**是否交回人工由配置 denyMode 决定**。
  // 评审器的 ask 只表示"我判不了"（证据自相矛盾/范围无法确定），它**不能越过配置**去决定问人 ——
  // 否则 denyMode: deny 会被架空（自测里"无授权改 hosts"就是这么变成 ask 的）。
  if (cfg.denyMode === 'ask') {
    return {
      kind: 'ask',
      reason: `escalation-review: denied${hasReason ? ` — ${decision.reason}` : ''}`,
    }
  }
  return {
    kind: 'deny',
    // 理由必须进**顶层 reason**：宿主把这一行显示给模型（info.reason 模型看不到）
    reason: `escalation-review: rejected, body not executed${hasReason ? ` — ${decision.reason}` : ''}`,
    info: { name: deniedName, code: deniedCode, ...(hasReason ? { reason: decision.reason } : {}) },
  }
}
