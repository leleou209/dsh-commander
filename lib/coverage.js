/**
 * 检查覆盖度（2.9.55）：宿主 profile 里配了几条受控检查，与仓库里到底有几套测试比对。
 *
 * 为什么单独成模块：
 *   - `doctor.js` 的 `createDoctor` / `doctorReport` 是 style 棘轮基线（只降不升），
 *     判定逻辑放在被调用方之外，doctorReport 里只换等价行数；
 *   - 覆盖度判定是纯文件/字符串逻辑，可以脱离宿主单测。
 *
 * 判据（用户口径）：「测试全绿」只在**覆盖 = 仓库全集**时成立。
 * 配的是子集时，doctor 必须报 FAIL 并列出缺项，而不是替子集背书。
 */

import fsp from 'node:fs/promises'
import { join } from 'node:path'

/** 从一条检查命令里取出它跑的 `test/<名字>.mjs` 基名（Windows/ POSIX 分隔符都认）。 */
export function testFilesOf(command) {
  const text = String(command ?? '')
  const hits = [...text.matchAll(/test[\\/]+([A-Za-z0-9_.-]+)\.mjs/g)]
  return hits.map((hit) => hit[1])
}

/**
 * 比较「配置的检查项」与「仓库里的 test/*.mjs」。
 *
 * @param {{pluginDir?: string, catalog?: Array<{name?: string, command?: string}>}} input
 * @returns {Promise<{level: 'PASS'|'FAIL'|'SKIP', text: string, missing: string[], files: string[], covered: string[]}>}
 */
export async function describeCheckCoverage(input = {}) {
  const catalog = Array.isArray(input.catalog) ? input.catalog : []
  const dir = input.pluginDir
  const skip = (text) => ({ level: 'SKIP', text, missing: [], files: [], covered: [] })
  if (!dir) return skip(`配置 ${catalog.length} 条（插件目录未知，无法比对仓库）`)

  let files = []
  try {
    const entries = await fsp.readdir(join(dir, 'test'))
    files = entries.filter((name) => name.endsWith('.mjs')).map((name) => name.slice(0, -4)).sort()
  } catch {
    return skip(`配置 ${catalog.length} 条（读不到 ${join(dir, 'test')}，无法比对仓库）`)
  }
  if (files.length === 0) return skip(`配置 ${catalog.length} 条（仓库里没有 test/*.mjs）`)

  const covered = new Set()
  for (const item of catalog) {
    for (const name of testFilesOf(item?.command ?? item?.name)) covered.add(name)
  }
  const coveredList = [...covered].sort()
  const missing = files.filter((name) => !covered.has(name))
  const head = `配置 ${coveredList.length}/${files.length} 套`
  if (missing.length > 0) {
    return {
      level: 'FAIL',
      text: `${head}，缺 ${missing.join('、')}；此时「全绿」只代表这个子集`,
      missing,
      files,
      covered: coveredList,
    }
  }
  return { level: 'PASS', text: `${head}（等于仓库全集）`, missing: [], files, covered: coveredList }
}
