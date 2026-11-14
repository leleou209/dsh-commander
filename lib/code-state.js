/**
 * 工作区代码状态指纹。
 *
 * 只由**文件内容**决定（相对路径 + 内容哈希，>1 MiB 的文件退回 size+mtime），
 * 排除工作区根部的 `doc/` 与构建产物。
 *
 * **不含 git HEAD**：提交本身不改变内容时不该让放行失效，而“只提交 doc/”也会
 * 移动 HEAD —— 绑它等于让文档提交误伤放行。提交号仅在 `describeGitHead()` 里
 * 供人查看，不参与绑定。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** 任意层级都跳过（构建产物 / 依赖 / 缓存）。 */
export const CODE_STATE_SKIP = new Set([
  'node_modules',
  '.git',
  '.dsh',
  '.codex',
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  'dist',
  'build',
  'target',
  'coverage',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
])

/** 只排除工作区根部的 doc/：`commander_record` 与计划板写入不该让放行失效。 */
export const CODE_STATE_ROOT_ONLY_SKIP = new Set(['doc', '.git'])

/** 超过该大小的文件改用 size+mtime，避免为超大文件反复读盘。 */
const CONTENT_HASH_LIMIT = 1024 * 1024

/** 读 `.git` 目录；worktree/submodule 的 `.git` 是文件，内容是 `gitdir: <path>`。 */
async function gitDir(root) {
  const dotGit = join(root, '.git')
  let info
  try {
    info = await stat(dotGit)
  } catch {
    return undefined
  }
  if (info.isDirectory()) return dotGit
  if (!info.isFile()) return undefined
  try {
    const text = (await readFile(dotGit, 'utf8')).trim()
    const match = /^gitdir:\s*(.+)$/i.exec(text)
    if (!match) return undefined
    const target = match[1].trim()
    return target.startsWith('/') || /^[A-Za-z]:/.test(target) ? target : join(root, target)
  } catch {
    return undefined
  }
}

/**
 * 把 `.git/HEAD` 解析成真实提交号。
 *
 * 直接 hash `.git/HEAD` 只反映分支名（提交不会改变它），所以这里解析 `ref: refs/heads/x`
 * 到 loose ref 或 `packed-refs`，detached HEAD 则本身就是提交号。
 */
async function resolveGitHead(root) {
  const dir = await gitDir(root)
  if (!dir) return ''
  let raw = ''
  try {
    raw = (await readFile(join(dir, 'HEAD'), 'utf8')).trim()
  } catch {
    return ''
  }
  if (!raw) return ''
  if (!raw.startsWith('ref:')) return raw
  const ref = raw.slice(4).trim()
  if (!ref) return ''
  try {
    const sha = (await readFile(join(dir, ref), 'utf8')).trim()
    if (sha) return sha
  } catch {
    // 未打包？继续尝试 packed-refs
  }
  try {
    const packed = await readFile(join(dir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue
      const [sha, name] = trimmed.split(/\s+/)
      if (name === ref && sha) return sha
    }
  } catch {
    // best-effort：refs 目录不存在时由 packed-refs 继续解析
  }
  // 解析不到提交：退回 ref 名，至少切分支/改名会变化。
  return ref
}

/**
 * 计算工作区代码状态指纹。
 * @param {string} root 工作区根目录
 * @param {{maxFiles?: number, maxDepth?: number}} [options]
 * @returns {Promise<string>} `CS-<snapshot>[-<head>]`
 */
export async function computeCodeState(root, options = {}) {
  const parts = []
  const maxFiles = options.maxFiles ?? 4000
  const maxDepth = options.maxDepth ?? 8
  const walk = async (dir, depth) => {
    if (depth > maxDepth || parts.length >= maxFiles) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (parts.length >= maxFiles) break
      if (depth === 0 && CODE_STATE_ROOT_ONLY_SKIP.has(entry.name)) continue
      if (CODE_STATE_SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const key = relative(root, full).split(sep).join('/')
      try {
        const info = await stat(full)
        if (info.size <= CONTENT_HASH_LIMIT) {
          const digest = createHash('sha256').update(await readFile(full)).digest('hex').slice(0, 16)
          parts.push(`${key}:${digest}`)
        } else {
          parts.push(`${key}:${info.size}:${Math.floor(info.mtimeMs)}`)
        }
      } catch {
        // 忽略不可读文件
      }
    }
  }
  await walk(root, 0)
  const snapshot = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
  return `CS-${snapshot}`
}

/**
 * 当前提交号（只用于 status/doctor 展示，**不参与**放行绑定）。
 *
 * 放行只绑内容快照：提交本身不改内容时不该让放行失效，而 `.git/HEAD` 在只改
 * `doc/` 的提交后也会变化，绑进去就会误伤。
 */
export async function describeGitHead(root) {
  const head = await resolveGitHead(root)
  if (!head) return ''
  return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 8) : head
}
