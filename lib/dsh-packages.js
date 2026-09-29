/**
 * dsh-packages.js —— 解析并导入 @deepseek-ai/* 包
 *
 * 为什么需要它：插件用 GUI 的「添加插件」安装时是 **link:** 依赖（软链到源码目录），
 * 于是模块 URL 落在 workspace 里，而 ESM 是**按模块自身路径**往上找 node_modules 的
 * —— workspace 树里没有 @deepseek-ai/*，裸 import 会 ERR_MODULE_NOT_FOUND
 * （实测：copy 安装时能解析，link 安装后不能）。
 *
 * 解法：用 createRequire 以 **profile 的 package.json** 为解析根拿到绝对路径，再 import。
 *
 * ⚠️ 关键（2026-09-27 实测定位，踩了很久）：
 *   `require.resolve()` 是按 **`require` 条件**解析的 → 对双构建包（如 `@deepseek-ai/schemastery`：
 *   `exports['.'].import = lib/index.mjs`、`require = lib/index.cjs`）拿到的是 **CJS 入口**。
 *   而在 **Electron 主进程**里 `import()` 那个 CJS 会 `ERR_REQUIRE_ESM_RACE_CONDITION`
 *   （CJS 内部再去 require ESM 实现，撞上加载竞态）→ 表现为"拿不到 schemastery" → `Config = undefined`
 *   → 设置命名空间不被服务 → 配置页永远不出现。
 *   所以这里**主动按 `import` 条件挑入口**，并且在 `.cjs` 有同名 `.mjs` 时优先 `.mjs`。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 上一次成功导入时命中的解析根（给日志用：别再写死"按 profile"）。 */
let lastRoot = null

/** 最近一次成功导入所使用的解析根（应用自身 / profile / 裸 import / asar 猜测）。 */
export function lastResolutionRoot() {
  return lastRoot
}

/** 解析根候选：**运行中的应用自身优先**，再 desktop profile，再 profiles 根。 */
function resolutionRoots() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE
  const roots = []
  // ⚠️ 优先用**运行中的应用自身**内置的包（新版把 0.2.0 的包放在 app.asar 内层 dsh/ 下）。
  //    升级后 profile 的 node_modules 可能仍是旧版本（实测 0.1.7-rc.2），先解析 profile 会加载到旧包。
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    roots.push(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
    roots.push(join(process.resourcesPath, 'app', 'dsh', 'package.json'))
  }
  if (typeof profile === 'string' && profile.length > 0) roots.push(join(home, 'profiles', profile, 'package.json'))
  roots.push(join(home, 'profiles', 'desktop', 'package.json'), join(home, 'profiles', 'package.json'))
  return roots
}

/** 从一个 `exports` 条件对象里挑出 ESM 入口。 */
function pickImportTarget(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  return value.import ?? value.node ?? value.module ?? value.default
}

/** 按 `import` 条件把一个包说明符解析成**绝对文件路径**（拿不到就返回 undefined）。 */
function resolveEsmEntry(req, specifier) {
  try {
    const packageJson = req.resolve(`${specifier}/package.json`)
    if (existsSync(packageJson)) {
      const pkg = JSON.parse(readFileSync(packageJson, 'utf8'))
      const target = pickImportTarget(pkg.exports?.['.']) ?? pkg.module ?? pkg.main
      if (typeof target === 'string') {
        const file = join(dirname(packageJson), target)
        if (existsSync(file)) return file
      }
    }
  } catch {
    /* 包没导出 ./package.json → 走下面的通用回退 */
  }
  const resolved = req.resolve(specifier)
  if (typeof resolved === 'string' && resolved.endsWith('.cjs')) {
    const asMjs = resolved.replace(/\.cjs$/, '.mjs')
    if (existsSync(asMjs)) return asMjs
  }
  return resolved
}

/**
 * 导入一个 DSH 内部包。失败时 throw，并把每次尝试的原因带在 error.attempts 上。
 * @param specifier - 例如 '@deepseek-ai/schemastery'
 */
export async function importDshPackage(specifier) {
  const attempts = []
  for (const manifest of resolutionRoots()) {
    if (!existsSync(manifest)) continue
    try {
      const req = createRequire(manifest)
      const entry = resolveEsmEntry(req, specifier)
      lastRoot = manifest
      return await import(pathToFileURL(entry).href)
    } catch (error) {
      attempts.push(`${manifest}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  try {
    const bare = await import(specifier)
    lastRoot = 'bare import'
    return bare
  } catch (error) {
    attempts.push(`bare import: ${error?.code ?? error?.message ?? error}`)
  }
  const resources = typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0 ? process.resourcesPath : ''
  if (resources.length > 0) {
    const guess = join(resources, 'app.asar', 'dsh', 'node_modules', ...specifier.split('/'), 'lib', 'index.mjs')
    try {
      lastRoot = guess
      return await import(pathToFileURL(guess).href)
    } catch (error) {
      attempts.push(`asar guess ${guess}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  const failure = new Error(`cannot import ${specifier}`)
  failure.attempts = attempts
  throw failure
}

/** 拿到默认导出的“类 zod”对象（schemastery 有 default / 命名导出两种形态）。 */
export async function importSchema() {
  const mod = await importDshPackage('@deepseek-ai/schemastery')
  const schema = mod?.default ?? mod
  if (schema === undefined || typeof schema.object !== 'function') {
    throw new Error('@deepseek-ai/schemastery did not expose a schema builder')
  }
  return schema
}
