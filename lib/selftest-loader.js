/**
 * selftest-loader.js —— 可选的策略自测用例装载器。
 *
 * 自测用例**不在这个包里**（`lib/selftest.js` 不存在）：只有你显式提供一个模块时它才可能跑起来，
 * 否则下面的候选全部落空，调用方记 `selftest-unavailable` 后继续工作 —— 自测是诊断功能，缺它不影响评审
 * （评审、拒绝、熔断、只读工具都不依赖它）。
 *
 * 查找顺序：
 *   1) 环境变量 DSH_ER_SELFTEST_MODULE（绝对路径）
 *   2) 配置项 selftestModule（绝对路径）
 *   3) 包内 ./selftest.js（相对本文件；**随包不存在**，只有你自己放进库目录时才有）
 */
import { pathToFileURL } from 'node:url'

function toSpecifier(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const text = value.trim()
  // 只有真正的 URL scheme 当 URL；Windows 盘符（D:/…）必须走 pathToFileURL，否则 import 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME\n  if (/^(file|node|data|https?):/i.test(text)) return text
  return pathToFileURL(text).href
}

export async function loadSelfTest(cfg) {
  const candidates = [
    toSpecifier(process.env.DSH_ER_SELFTEST_MODULE),
    toSpecifier(cfg ? cfg.selftestModule : undefined),
    new URL('./selftest.js', import.meta.url).href,
  ].filter((entry) => typeof entry === 'string' && entry.length > 0)

  const attempts = []
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier)
      if (typeof mod?.runSelfTest === 'function') return mod
      attempts.push(specifier + ': no runSelfTest export')
    } catch (error) {
      attempts.push(specifier + ': ' + String(error?.code ?? error?.message ?? error))
    }
  }
  const failure = new Error('optional self-test module is not installed')
  failure.attempts = attempts
  throw failure
}
