#!/usr/bin/env node
/**
 * inspect-session.mjs —— 查看 DSH 会话记录的结构（zstd 压缩的 JSONL）
 *
 * 用法: node tools/inspect-session.mjs <session.v4.jsonl.zstd 路径> [关键字]
 *
 * 用途：
 *   - 搞清楚会话事件形状（事件类型分布、工具调用/审批事件长什么样）
 *   - 回答"DSH 能不能读别的会话"：能，记录就在 ~/.dsh/sessions/ 下，本脚本即可解压阅读
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/**
 * 会话文件是**多帧拼接**的 zstd（每次追加一帧），zstdDecompressSync 只解第一帧。
 * 这里按帧魔数 (28 B5 2F FD) 切开逐帧解压；解不开的当作压缩数据里的巧合魔数跳过。
 */
function decompressAll(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = 0
  while ((index = buffer.indexOf(MAGIC, index)) >= 0) {
    offsets.push(index)
    index += MAGIC.length
  }
  if (offsets.length <= 1) return zstdDecompressSync(buffer)
  const parts = []
  let skipped = 0
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      skipped += 1
    }
  }
  if (skipped > 0) console.error(`(跳过 ${skipped} 个疑似巧合魔数)`)
  return Buffer.concat(parts)
}

const file = process.argv[2]
const keyword = process.argv[3]
if (file === undefined) {
  console.error('用法: node tools/inspect-session.mjs <session.v4.jsonl.zstd> [关键字]')
  process.exit(2)
}

const text = decompressAll(readFileSync(file)).toString('utf8')
const lines = text.split('\n').filter((line) => line.length > 0)
console.log(`行数: ${lines.length}`)

const types = new Map()
let bad = 0
const samples = new Map()
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    bad += 1
    continue
  }
  const type = String(event.type ?? event.kind ?? 'unknown')
  types.set(type, (types.get(type) ?? 0) + 1)
  if (!samples.has(type)) samples.set(type, JSON.stringify(event).slice(0, 300))
}
console.log(`无法解析的行: ${bad}`)
console.log('事件类型分布:')
for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(6)}  ${type}`)
}

if (keyword !== undefined) {
  console.log(`\n含关键字 "${keyword}" 的事件（最多 5 条，每条截断 900 字符）:`)
  let shown = 0
  for (const line of lines) {
    if (shown >= 5) break
    if (!line.includes(keyword)) continue
    shown += 1
    console.log(`  [${shown}] ${line.slice(0, 900)}`)
  }
  if (shown === 0) console.log('  (无)')
}

console.log('\n每种类型的第一条样例（截断 300）:')
for (const [type, sample] of samples) console.log(`  ${type}: ${sample}`)
