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
 * 倒序追加一条 history（最新在上，插在标题与引言之后）。
 * 读不到原文件就整份重写，绝不因为一次写入失败把已有内容清掉。
 */
export async function prependHistory(file, entry) {
  const original = await fsp.readFile(file, 'utf8').catch(() => undefined)
  if (original === undefined) {
    await fsp.writeFile(file, `${HEADER('history.md')}\n${entry}\n`, 'utf8')
    return
  }
  const lines = original.split(/\r?\n/)
  let insertAt = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.startsWith('#') || line.startsWith('>') || line.length === 0) {
      insertAt = index + 1
      continue
    }
    break
  }
  const next = [...lines.slice(0, insertAt), '', entry, ...lines.slice(insertAt)]
  await fsp.writeFile(file, next.join('\n'), 'utf8')
}

/** 一条 history 记录的格式。 */
export function formatHistoryEntry(summary, details, now = new Date()) {
  const stamp = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const lines = [`## ${stamp}`, '', `- ${String(summary ?? '').trim()}`]
  const extra = String(details ?? '').trim()
  if (extra.length > 0) lines.push('', extra)
  return lines.join('\n')
}
