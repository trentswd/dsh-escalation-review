/**
 * action-fingerprint.js —— 待审动作的**规范指纹**（TOCTOU 复核用）
 *
 * 为什么需要它：评审开始时动作证据就冻结进了 prompt，但"被评审的动作"与"实际执行的动作"必须
 * 是同一个。若 host 或别的插件在评审期间改动了同一个 callId 的 `exec.arguments`，插件原先察觉不到。
 * 这里给出一个**只回答"变没变"**的指纹：
 *
 *   · 稳定序列化：对象键**排序**、数组保持顺序、原始类型带类型前缀（`s:` / `n:` / `b:` / `u` / `f` / `y`），
 *     循环引用按**出现位置**记 `[cycle:depth]`（结构性相同的对象得到相同指纹），超过深度记 `[depth:n]`；
 *   · **流式**喂进 sha256：canonical 内容既不落盘也不驻留（内存 O(1)），因此**任何位置**的改动都能检出 ——
 *     包括超长输入的中部改动。早期版本在 1 MiB 处把超大块**整体丢弃**，两个巨串会撞成同一个
 *     （= 空串 sha256）指纹，长度相同的内容改动检测不到；现在内容全部参与哈希；
 *   · 输出 `{ hash, bytes, totalBytes, truncated }`：hash = sha256 前 16 位十六进制；
 *     `truncated=true` 只表示"canonical 形态超过 MAX_FINGERPRINT_BYTES，日志里只有哈希"，
 *     **不代表检测能力被削弱**；
 *   · 节点数超过上限 → 返回 `undefined`（"算不出指纹"）→ 调用方必须 **fail-closed**，绝不"比不了就放行"。
 *
 * 边界（写死在这里，改代码前先读）：指纹**只判断"变没变"**，不参与判定语义，不是新授权、不是证据更新；
 * 两边都拿不到指纹时按 fail-closed 处理。
 *
 * 这个文件**只做纯计算**：不读文件、不碰网络、不调宿主服务。
 */
import { createHash } from 'node:crypto'

/** canonical 形态的**报告阈值**：超过它即 `truncated=true`（只影响日志标注，不影响哈希覆盖范围）。 */
export const MAX_FINGERPRINT_BYTES = 1024 * 1024
/** 递归深度上限：超过只记录深度标记（结构性可比）。 */
export const MAX_FINGERPRINT_DEPTH = 64
/** 节点数上限：超过视为"算不出指纹"（调用方 fail-closed）。 */
export const MAX_FINGERPRINT_NODES = 200_000

/**
 * 取一个值的指纹：**流式**哈希整个 canonical 形态（内存 O(1)，内容不留存）。
 *
 * 返回结构的字段语义（别误读成"截断=不可靠"）：
 *   · `hash` —— 覆盖**全部**内容（含超长输入的中部），不是"头尾片段"的哈希；
 *   · `bytes` / `totalBytes` —— canonical 形态的字节数（当前两者相等；`bytes` 是历史字段名）；
 *   · `truncated` —— **仅表示"这段 canonical 形态超过 MAX_FINGERPRINT_BYTES"**，供日志标注；
 *     它**不代表检测能力被削弱**（内容 100% 参与了哈希，任何位置改动都会改变 `hash`）；
 *   · `nodes` —— 参与序列化的节点数。
 *
 * @param {unknown} value
 * @returns {{ hash: string, bytes: number, totalBytes: number, truncated: boolean, nodes: number } | undefined}
 *          节点超限时返回 undefined（算不出）。
 */
export function fingerprintOf(value) {
  const hash = createHash('sha256')
  let bytes = 0
  let nodes = 0
  const onPath = new Set()

  const emit = (chunk) => {
    bytes += Buffer.byteLength(chunk, 'utf8')
    hash.update(chunk)
  }

  const walk = (node, depth) => {
    nodes += 1
    if (nodes > MAX_FINGERPRINT_NODES) throw new Error('fingerprint node budget exceeded')
    if (node === null) {
      emit('null')
      return
    }
    const type = typeof node
    if (type === 'undefined') { emit('u'); return }
    if (type === 'boolean') { emit(node ? 'true' : 'false'); return }
    if (type === 'number') { emit(`n:${String(node)}`); return }
    if (type === 'bigint') { emit(`b:${node.toString()}`); return }
    if (type === 'string') { emit(`s:${JSON.stringify(node)}`); return }
    if (type === 'function' || type === 'symbol') { emit(type === 'function' ? 'f' : 'y'); return }
    if (depth > MAX_FINGERPRINT_DEPTH) { emit(`[depth:${depth}]`); return }
    if (onPath.has(node)) { emit(`[cycle:${depth}]`); return }
    onPath.add(node)
    try {
      if (Array.isArray(node)) {
        emit('[')
        for (let index = 0; index < node.length; index += 1) {
          if (index > 0) emit(',')
          walk(node[index], depth + 1)
        }
        emit(']')
      } else {
        emit('{')
        const keys = Object.keys(node).sort()
        for (let index = 0; index < keys.length; index += 1) {
          if (index > 0) emit(',')
          emit(`${JSON.stringify(keys[index])}:`)
          walk(node[keys[index]], depth + 1)
        }
        emit('}')
      }
    } finally {
      onPath.delete(node)
    }
  }

  try {
    walk(value, 0)
  } catch {
    return undefined
  }
  return {
    hash: hash.digest('hex').slice(0, 16),
    bytes,
    totalBytes: bytes,
    truncated: bytes > MAX_FINGERPRINT_BYTES,
    nodes,
  }
}

/** 待审动作的指纹：只覆盖动作参数（`exec.arguments`），评审语义不依赖它。 */
export function fingerprintOfArguments(args) {
  return fingerprintOf(args ?? null)
}

/**
 * 两个指纹是否表示**同一个**动作。
 * 任一边缺失 → false（调用方按 fail-closed 处理）；长度或"太大"标注不同也算变了。
 */
export function sameActionFingerprint(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false
  const totalA = typeof a.totalBytes === 'number' ? a.totalBytes : a.bytes
  const totalB = typeof b.totalBytes === 'number' ? b.totalBytes : b.bytes
  return a.hash === b.hash && totalA === totalB && a.truncated === b.truncated
}

/**
 * 从会话事件流里取某个 callId **当前记录的动作**指纹。
 * 用于 `approval/request` 出口（那里拿不到活的 `exec`，只有请求对象）。
 * 事件流里最新一条同 callId 的 `tool/call` 的 `data.arguments` 即该调用的记录动作。
 * 读不到 / 解析失败 → undefined（调用方 fail-closed）。
 */
export function fingerprintFromSession(session, callId) {
  if (typeof callId !== 'string' || callId.length === 0) return undefined
  let events
  try {
    events = session?.snapshotEvents?.()
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    const data = event.data ?? {}
    if (String(data.callId ?? '') !== callId) continue
    let args = data.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        return undefined
      }
    }
    return fingerprintOfArguments(args)
  }
  return undefined
}

/** 指纹的日志形态：只留短哈希与有界元数据（绝不放 canonical 内容）。 */
export function fingerprintForLog(fingerprint) {
  if (fingerprint === undefined || fingerprint === null) return null
  return {
    hash: fingerprint.hash,
    bytes: fingerprint.bytes,
    totalBytes: typeof fingerprint.totalBytes === 'number' ? fingerprint.totalBytes : fingerprint.bytes,
    truncated: fingerprint.truncated === true,
  }
}
