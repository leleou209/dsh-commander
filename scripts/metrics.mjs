// 一次性：算出当前各文件的函数长度，用于生成 BASELINE
import fs from 'node:fs'

const files = fs.readdirSync('.').filter((f) => f.endsWith('.js'))
const rows = []
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*\(/)
    if (m) starts.push({ name: m[2], start: i })
  }
  for (const fn of starts) {
    let depth = 0
    let started = false
    let end = fn.start
    for (let i = fn.start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') {
          depth += 1
          started = true
        } else if (ch === '}') depth -= 1
      }
      if (started && depth === 0) {
        end = i
        break
      }
    }
    rows.push({ file, name: fn.name, len: end - fn.start + 1 })
  }
}

console.log('=== 文件行数 ===')
for (const file of files) {
  const n = fs.readFileSync(file, 'utf8').split(/\r?\n/).length
  console.log(String(n).padStart(6), file)
}

console.log('\n=== 超过 120 行的函数 ===')
for (const r of rows.filter((x) => x.len > 120).sort((a, b) => b.len - a.len)) {
  console.log(String(r.len).padStart(5), r.file, r.name)
}

console.log('\n=== 超过 140 字符的行 ===')
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const long = lines.map((l, i) => ({ i: i + 1, n: l.length })).filter((x) => x.n > 140)
  if (long.length > 0) console.log(file, long.map((x) => `L${x.i}(${x.n})`).join(' '))
}
