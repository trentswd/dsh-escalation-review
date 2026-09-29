/**
 * limit-pool.js —— 有上限的并发池（评审用）。
 *
 * 为什么需要：多个越界调用可能**同时**到达 `tools/pre-execute`。默认 `reviewConcurrency: 1`
 * 时行为必须与从前完全一致（一个接一个）；调大上限可以有多个评审并行，但**绝不越过上限**，
 * 超出的先**排队**（不丢弃），并且排队时间要能被调用方计入自己的超时/预算口径
 * （否则排队会把一次工具调用拖到无限期）。
 *
 * 设计取舍：
 *   · 不引入依赖，几十行；上限从 `getLimit()` **每次取用**读，所以配置改动即时生效；
 *   · 结果是**逐任务**投递的（job.resolve/reject 各自独立）→ 并行时互不串号；
 *   · 三种"还没轮到就作废"的出口都在池内收口：调用方已取消、排队超过 deadline、达到上限。
 *     deadline 用**绝对时刻**（调用方按自己的总预算算好），所以池本身不需要知道预算语义。
 */

/** 取消类错误：排队期间调用方撤销（评审侧按 fail-closed 处理，且不重试）。 */
function cancelledError() {
  const error = new Error('review was cancelled while waiting for a free review slot')
  error.name = 'AbortError'
  error.reviewerQueue = 'cancelled'
  return error
}

/** 排队把预算等没了：这是"没等到机会"，不是评审失败重试能救的（不重试，直接 fail-closed）。 */
function budgetError() {
  const error = new Error('review slot wait would exceed the review budget')
  error.reviewerQueue = 'budget'
  return error
}

/**
 * 建一个有上限的并发池。
 * @param getLimit - 返回当前并发上限（≥1 的整数；取不到时按 1）。
 */
export function createLimitPool(getLimit) {
  /** @type {{ fn: Function, resolve: Function, reject: Function, signal?: AbortSignal, deadline?: number, enqueuedAt: number, timer?: any, onAbort?: Function }[]} */
  const queue = []
  let active = 0
  let peak = 0
  let admitted = 0

  const limitNow = () => {
    const value = Math.floor(Number(typeof getLimit === 'function' ? getLimit() : getLimit))
    return Number.isFinite(value) && value >= 1 ? value : 1
  }

  /** 只要还有额度就把队首放出来（被作废的任务不占额度）。 */
  const admit = () => {
    const limit = limitNow()
    while (active < limit && queue.length > 0) {
      const job = queue.shift()
      if (job.timer !== undefined) clearTimeout(job.timer)
      if (job.signal !== undefined && job.onAbort !== undefined) job.signal.removeEventListener('abort', job.onAbort)
      if (job.signal?.aborted === true) {
        job.reject(cancelledError())
        continue
      }
      if (job.deadline !== undefined && Date.now() >= job.deadline) {
        job.reject(budgetError())
        continue
      }
      active += 1
      admitted += 1
      if (active > peak) peak = active
      const waitedMs = Date.now() - job.enqueuedAt
      Promise.resolve()
        .then(() => job.fn(waitedMs))
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1
          admit()
        })
    }
  }

  /**
   * 排队执行一个任务。
   * @param fn - 真正的工作；收到**排队等待毫秒数**（0 = 立刻拿到额度），调用方用它压缩自己的预算。
   * @param options.deadline - 绝对时刻（ms）；还在排队时越过它就作废。
   * @param options.signal - 调用方取消信号；排队期间撤销立即作废。
   * @param options.onQueue - 只有真的要排队时才回调（拿到当前队列长度）——用来写"排队中"日志。
   * @returns 该任务自己的结果 Promise。
   */
  const run = (fn, options = {}) => new Promise((resolve, reject) => {
    const job = {
      fn,
      resolve,
      reject,
      signal: options.signal,
      deadline: typeof options.deadline === 'number' && Number.isFinite(options.deadline) ? options.deadline : undefined,
      enqueuedAt: Date.now(),
    }

    if (typeof options.deadline === 'number' && Number.isFinite(options.deadline)) {
      const remaining = options.deadline - Date.now()
      if (remaining <= 0) {
        reject(budgetError())
        return
      }
      job.timer = setTimeout(() => {
        const index = queue.indexOf(job)
        if (index < 0) return
        queue.splice(index, 1)
        reject(budgetError())
      }, remaining)
      if (typeof job.timer?.unref === 'function') job.timer.unref()
    }

    if (job.signal !== undefined && job.signal !== null) {
      if (job.signal.aborted === true) {
        if (job.timer !== undefined) clearTimeout(job.timer)
        reject(cancelledError())
        return
      }
      job.onAbort = () => {
        const index = queue.indexOf(job)
        if (index < 0) return
        queue.splice(index, 1)
        if (job.timer !== undefined) clearTimeout(job.timer)
        reject(cancelledError())
      }
      job.signal.addEventListener('abort', job.onAbort, { once: true })
    }

    const willWait = active >= limitNow() || queue.length > 0
    queue.push(job)
    if (willWait && typeof options.onQueue === 'function') options.onQueue(queue.length)
    admit()
  })

  return {
    run,
    /** 当前状态（日志/核对用）：活跃数、排队数、峰值、累计放行数。 */
    stats: () => ({ active, queued: queue.length, peak, admitted }),
  }
}
