/**
 * 受控检查（commander action=checks）：只执行配置 checkCommands 里列出的命令。
 *
 * 2.9.38 P1 从 index.js 搬出，**逻辑逐行未改**；差异只有两处：
 *   - 依赖（t / config）由工厂注入，不再直接读 apply() 闭包；
 *   - 并发标志从闭包变量变成工厂内的私有变量，语义不变（并发上限 1）。
 *
 * 依赖方向：只依赖 node:child_process 与注入的依赖，不反向 import index.js。
 */

import { spawn } from 'node:child_process'

/**
 * @param {{t: (key: string, params?: any) => string, config: any}} deps
 */
export function createChecks({ t, config }) {
  const CHECK_MAX_LINES = 200
  const CHECK_MAX_BYTES = 32 * 1024
  let checkRunning = false

  /** 解析 `checkCommands`：`name = command` 或直接 command。 */
  function checkCatalog() {
    return (config.checkCommands ?? [])
      .map((entry) => String(entry ?? '').trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const named = /^([A-Za-z0-9_.:-]+)\s*=\s*(.+)$/.exec(entry)
        if (named) return { name: named[1], command: named[2].trim() }
        const words = entry.split(/\s+/).slice(0, 2).join(' ')
        return { name: words, command: entry }
      })
  }

  /** 截断输出：保留末尾若干行/字节。 */
  function tailText(text, maxLines, maxBytes) {
    let value = String(text ?? '')
    let truncated = false
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      value = value.slice(-maxBytes)
      truncated = true
    }
    const lines = value.split(/\r?\n/)
    if (lines.length > maxLines) {
      value = lines.slice(-maxLines).join('\n')
      truncated = true
    }
    return { text: value, truncated }
  }

  /** 杀掉整棵进程树：POSIX 用进程组，Windows 用 taskkill /T。 */
  function killTree(child) {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref?.()
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // best-effort：进程可能已退出，SIGKILL 失败不需要处理
        }
      }
      return
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // best-effort：进程可能已退出，SIGKILL 失败不需要处理
      }
    }
  }

  /** 执行一条受控检查。 */
  function spawnCheck(item, cwd) {
    return new Promise((resolvePromise) => {
      const startedAt = Date.now()
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const child = spawn(item.command, {
        cwd,
        shell: true,
        detached: process.platform !== 'win32',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, config.checkTimeoutMs)
      const collect = (chunk, target) => {
        const text = String(chunk)
        const combined = target + text
        // 只保留尾部，避免长输出吃内存
        return combined.length > CHECK_MAX_BYTES * 2 ? combined.slice(-CHECK_MAX_BYTES * 2) : combined
      }
      child.stdout?.on('data', (chunk) => {
        stdout = collect(chunk, stdout)
      })
      child.stderr?.on('data', (chunk) => {
        stderr = collect(chunk, stderr)
      })
      const finish = (exitCode, error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const merged = [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join('\n')
        const tail = tailText(merged, CHECK_MAX_LINES, CHECK_MAX_BYTES)
        resolvePromise({
          item,
          exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
          output: tail.text,
          truncated: tail.truncated,
          error: error ? (error?.message ?? String(error)) : undefined,
        })
      }
      child.on('error', (error) => finish(undefined, error))
      child.on('close', (code) => finish(code ?? (timedOut ? undefined : 1)))
    })
  }

  /** commander(action=checks)：运行/列出受控检查。 */
  async function runChecks(agent, cwd, requested) {
    const catalog = checkCatalog()
    if (catalog.length === 0) return { kind: 'empty', text: t('checks.empty') }
    if (!requested) {
      const items = catalog.map((row) => `- ${row.name}：\`${row.command}\``).join('\n')
      return { kind: 'list', text: t('checks.list', { items }) }
    }
    const item = catalog.find((row) => row.name === requested)
    if (!item) {
      return {
        kind: 'unknown',
        text: t('checks.unknown', { name: requested, names: catalog.map((row) => row.name).join('、') }),
      }
    }
    if (checkRunning) return { kind: 'busy', text: t('checks.busy') }
    checkRunning = true
    try {
      const result = await spawnCheck(item, cwd)
      const status = result.timedOut
        ? t('checks.timeout', { limit: Math.round(config.checkTimeoutMs / 1000) })
        : result.exitCode === 0
          ? 'PASS'
          : 'FAIL'
      const head = t('checks.result', {
        name: item.name,
        status,
        exitCode: result.exitCode ?? '—',
        duration: `${(result.durationMs / 1000).toFixed(1)}s`,
      })
      const parts = [head]
      if (result.truncated) {
        parts.push(t('checks.truncated', { lines: CHECK_MAX_LINES, bytes: CHECK_MAX_BYTES }))
      }
      if (result.output.length > 0) parts.push('```\n' + result.output + '\n```')
      return {
        kind: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'pass' : 'fail',
        text: parts.join('\n'),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      }
    } finally {
      checkRunning = false
    }
  }
  return {
    /** 解析后的检查清单（doctor 也要用）。 */
    catalog: checkCatalog,
    runChecks,
    isRunning: () => checkRunning,
    maxLines: CHECK_MAX_LINES,
    maxBytes: CHECK_MAX_BYTES,
  }
}
