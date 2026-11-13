/**
 * 代码规范守卫（零依赖的"lint"）。
 *
 * 为什么用测试当 lint：
 *   - 插件刻意保持零运行依赖，不引 eslint/prettier；
 *   - 规范里最容易被破坏的是**体量**（单文件/单函数越写越长）和**依赖方向**，
 *     这两类都能静态判定，放进 checks 就能每次发布前自动跑。
 *
 * 棘轮（ratchet）机制：
 *   - 新代码必须直接达标；
 *   - 历史遗留写进 BASELINE，**只能变小、不能变大**，也不能新增条目；
 *   - 修完一项就把它从 BASELINE 删掉，避免基线变成垃圾桶。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** 单文件行数上限（新文件必须达标）。 */
const MAX_FILE_LINES = 900
/** 单函数行数上限（新函数必须达标）。 */
const MAX_FUNCTION_LINES = 120
/** 单行字符上限（只统计非文本资产文件）。 */
const MAX_LINE_CHARS = 140

/**
 * 历史遗留：文件行数基线（只能降，不能升，不能新增 key）。
 * index.js 还有工具层/斜杠命令层没拆（P2 计划），拆完应把它删掉。
 */
const BASELINE_FILE_LINES = {
  'index.js': 3136,
}

/**
 * 历史遗留：长函数基线（key = `文件:函数名`，值为当前行数，只能降）。
 * 这些是"工厂外壳 + 内层函数"或待拆的老函数，拆一个删一条。
 */
const BASELINE_FUNCTION_LINES = {
  'index.js:apply': 2475,
  'index.js:waitCommander': 161,
  'index.js:commanderStatus': 136,
  'index.js:handleCommanderCommand': 133,
  'handoff-driver.js:createHandoffDriver': 281,
  'doctor.js:createDoctor': 234,
  'doctor.js:doctorReport': 178,
  'checks.js:createChecks': 167,
  'state-store.js:createStateStore': 239,
  'client.js:TakeoverBadge': 215,
}

/**
 * 历史遗留：超长行数量基线（按文件，只能降）。
 * 主要集中在文案/说明书这类文本资产里（长句本来就是一行）。
 */
const BASELINE_LONG_LINES = {
  'index.js': 10,
  'handoff-driver.js': 1,
  'manual.js': 21,
  'messages.js': 18,
  'prompts.js': 3,
  'protocol.js': 1,
  'state-store.js': 1,
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** 源码文件（不含测试与脚本）。 */
function sourceFiles() {
  return fs
    .readdirSync(root)
    .filter((file) => file.endsWith('.js'))
    .sort()
}

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

/** 抓所有具名函数（含嵌套），按花括号平衡算长度。 */
function functionLengths(file, lines) {
  const rows = []
  for (let i = 0; i < lines.length; i += 1) {
    const matched = lines[i].match(/^\s*(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*\(/)
    if (!matched) continue
    let depth = 0
    let started = false
    let end = i
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth += 1
          started = true
        } else if (ch === '}') {
          depth -= 1
        }
      }
      if (started && depth === 0) {
        end = j
        break
      }
    }
    rows.push({ file, name: matched[1], len: end - i + 1 })
  }
  return rows
}

check('单文件行数：新文件 ≤900，历史遗留只降不升', () => {
  for (const file of sourceFiles()) {
    const count = read(file).split(/\r?\n/).length
    const baseline = BASELINE_FILE_LINES[file]
    if (baseline === undefined) {
      assert.ok(count <= MAX_FILE_LINES, `${file} 有 ${count} 行，超过 ${MAX_FILE_LINES}`)
    } else {
      assert.ok(count <= baseline, `${file} 从基线 ${baseline} 涨到 ${count}；只允许变小`)
    }
  }
})

check('单函数行数：新函数 ≤120，历史遗留只降不升且不得新增条目', () => {
  const seen = new Set()
  for (const file of sourceFiles()) {
    const lines = read(file).split(/\r?\n/)
    for (const row of functionLengths(file, lines)) {
      const key = `${row.file}:${row.name}`
      const baseline = BASELINE_FUNCTION_LINES[key]
      if (baseline === undefined) {
        assert.ok(row.len <= MAX_FUNCTION_LINES, `${key} 有 ${row.len} 行，超过 ${MAX_FUNCTION_LINES}`)
      } else {
        seen.add(key)
        assert.ok(row.len <= baseline, `${key} 从基线 ${baseline} 涨到 ${row.len}；只允许变小`)
      }
    }
  }
  // 基线条目必须仍然存在（函数改名/删除后要同步清理基线）
  for (const key of Object.keys(BASELINE_FUNCTION_LINES)) {
    assert.ok(seen.has(key), `基线里的 ${key} 已经不存在了，请从 BASELINE_FUNCTION_LINES 删掉`)
  }
})

check('没有真正空的 catch（不允许静默吞异常）', () => {
  for (const file of sourceFiles()) {
    const lines = read(file).split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (!/catch\s*\{\s*\}/.test(lines[i])) continue
      assert.fail(`${file}:${i + 1} 是空 catch；要么加注释说明 best-effort，要么处理错误`)
    }
  }
})

check('超长行：新文件零容忍，历史遗留只降不升', () => {
  for (const file of sourceFiles()) {
    const long = read(file)
      .split(/\r?\n/)
      .filter((line) => line.length > MAX_LINE_CHARS).length
    const baseline = BASELINE_LONG_LINES[file] ?? 0
    assert.ok(long <= baseline, `${file} 有 ${long} 行超过 ${MAX_LINE_CHARS} 字符（基线 ${baseline}）`)
  }
})

check('依赖方向：模块不得反向 import index.js，且不得有环', () => {
  const graph = {}
  for (const file of sourceFiles()) {
    const source = read(file)
    graph[file] = [...source.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map((m) => `${m[1]}.js`)
    assert.ok(
      !graph[file].includes('index.js') || file === 'index.js',
      `${file} 反向 import 了 index.js（会形成环）`,
    )
  }
  const cycles = []
  const visit = (node, trail) => {
    if (trail.includes(node)) {
      cycles.push([...trail.slice(trail.indexOf(node)), node].join(' -> '))
      return
    }
    for (const next of graph[node] ?? []) visit(next, [...trail, node])
  }
  for (const file of Object.keys(graph)) visit(file, [])
  assert.equal([...new Set(cycles)].length, 0, `存在循环依赖：${[...new Set(cycles)].join('; ')}`)
})

check('基线本身不能变大（防止有人为了过检查去调高数字）', () => {
  assert.ok(BASELINE_FILE_LINES['index.js'] <= 3136, 'index.js 基线不允许上调')
  const total = Object.values(BASELINE_FUNCTION_LINES).reduce((sum, n) => sum + n, 0)
  assert.ok(total <= 4219, `长函数基线总和 ${total} 超过上限；只允许下降`)
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error && error.message ? error.message : error}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${checks.length} checks failed`)
  process.exit(1)
}
console.log(`\nSTYLE CHECKS PASSED (${checks.length})`)
