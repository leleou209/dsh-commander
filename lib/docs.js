/**
 * 四大件文档的最小维护：缺了就建骨架，history 倒序追加。
 * 只做这两件事——文档内容由指挥员和用户写，插件不代笔。
 */

import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { DOC_FILES, DOC_ROLES } from './prompt.js'

const HEADER = (file) => `# ${file.replace(/\.md$/, '')}\n\n> ${DOC_ROLES[file]}\n`

/** 确保 doc/ 与四个文件存在；返回绝对路径表。 */
export async function ensureDocs(cwd, docDir = 'doc') {
  const dir = join(cwd, docDir)
  await fsp.mkdir(dir, { recursive: true })
  const paths = {}
  for (const file of DOC_FILES) {
    const full = join(dir, file)
    paths[file.replace(/\.md$/, '')] = full
    try {
      await fsp.access(full)
    } catch {
      await fsp.writeFile(full, HEADER(file), 'utf8').catch(() => {})
    }
  }
  return paths
}

/**
 * 倒序追加一条记录（最新在上，插在标题与引言之后）。
 * 读不到原文件就整份重写，绝不因为一次写入失败把已有内容清掉。
 * `headerOf` 决定「文件不存在时用哪份骨架」，因此 history 与 plan 共用这一份实现。
 */
export async function prependEntry(file, entry, headerOf = 'history.md') {
  const original = await fsp.readFile(file, 'utf8').catch(() => undefined)
  if (original === undefined) {
    await fsp.writeFile(file, `${HEADER(headerOf)}\n${entry}\n`, 'utf8')
    return
  }
  const lines = original.split(/\r?\n/)
  let insertAt = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    // `## ` 是**第一条记录**（history 与 plan 的记录都用二级标题），不能当成文件头继续跳过。
    // 早先没这行判断，第二次写入会插进上一条记录的标题和正文之间。
    if (line.startsWith('##')) break
    if (line.startsWith('#') || line.startsWith('>') || line.length === 0) {
      insertAt = index + 1
      continue
    }
    break
  }
  const next = [...lines.slice(0, insertAt), '', entry, ...lines.slice(insertAt)]
  await fsp.writeFile(file, next.join('\n'), 'utf8')
}

/** 兼容旧调用点：history 的倒序追加。 */
export const prependHistory = (file, entry) => prependEntry(file, entry, 'history.md')

/** plan 的倒序追加（骨架用 plan.md 的头）。 */
export const prependPlan = (file, entry) => prependEntry(file, entry, 'plan.md')

const stamp = (now) =>
  `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

/** 一条 history 记录的格式。 */
export function formatHistoryEntry(summary, details, now = new Date()) {
  const lines = [`## ${stamp(now)}`, '', `- ${String(summary ?? '').trim()}`]
  const extra = String(details ?? '').trim()
  if (extra.length > 0) lines.push('', extra)
  return lines.join('\n')
}

/**
 * 一条 plan 记录的格式。
 *
 * 计划是**可演进的**，所以同样倒序追加、不覆盖旧版：最新一条就是当前计划，
 * 往下能看出计划怎么变过。标题可选，用于一句话概括这一版要解决什么。
 */
export function formatPlanEntry(plan, title, now = new Date()) {
  const heading = String(title ?? '').trim()
  const lines = [heading.length > 0 ? `## ${stamp(now)} · ${heading}` : `## ${stamp(now)}`, '', String(plan ?? '').trim()]
  return lines.join('\n')
}
