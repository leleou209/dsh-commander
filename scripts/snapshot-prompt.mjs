// 一次性：给 buildCommanderPrompt 生成确定性快照（重构前后对比用）
// 重构前从 index.js 导出，重构后从 prompts.js 导出——两者必须是同一个实现。
import fs from 'node:fs'

const out = process.argv[2]
if (!out) throw new Error('usage: node snapshot-prompt.mjs <out-file>')

async function load() {
  for (const mod of ['../prompts.js', '../index.js']) {
    try {
      const m = await import(mod)
      if (typeof m.buildCommanderPrompt === 'function') return m.buildCommanderPrompt
    } catch {
      // 继续试下一个
    }
  }
  throw new Error('buildCommanderPrompt 找不到')
}

const build = await load()

const docs = {
  round: 7,
  paths: {
    suggest: 'doc/suggest.md',
    history: 'doc/history.md',
    plan: 'doc/plan.md',
    agent: 'doc/agent.md',
  },
  snapshot: {
    suggest: '- 建议：先补失败用例。\n',
    history: '## 第 6 轮\n- 修了 X\n',
    plan: '## 当前计划\n- [ ] 做 Y\n',
    agent: '## 设计导向\n- 分层\n',
  },
}

const text = build({
  cwd: 'C:/repo',
  goal: { objective: '发布 2.9.38' },
  docs,
  config: { commanderName: 'commander' },
  modelLabel: 'deepseek-v4.1-flash',
  commanderId: 'session-abc',
})
fs.writeFileSync(out, text, 'utf8')
console.log('wrote', out, text.length, 'chars')
