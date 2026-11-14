/**
 * 会话日志修复器 —— 修复「结构越界事件」导致的 `SessionFormatError`。
 *
 * 症状：GUI 报 `stored session "…" is corrupt: SessionFormatError: <type> does not
 * match an open turn and step`，整条会话打不开。原因是某条消息类事件被写在
 * `turn/end` 之后（异步回调迟到），而 restore 校验要求它处在打开的 turn/step 内。
 *
 * 关键实现细节：**必须按原帧边界重建**。DSH 的会话日志是「每帧一次 append」的
 * 多帧 zstd 流；把 13,976 个帧重新压成 1 个帧，宿主的帧式读取器读不回来（实测）。
 * 所以这里先解析 zstd 帧边界、逐帧解码、改完后按原帧分组逐帧重压再拼接。
 *
 * 用法：
 *   node scripts/repair-session.mjs <session.v4.jsonl.zstd> [--drop-seq=17547] [--apply]
 *
 *   --drop-seq  要丢弃的事件 seq（省略则只做体检，不改内容）
 *   --apply     写回原文件（先在同目录生成 .bak-<时间戳> 备份）
 *
 * 退出码：0 正常（体检通过或修复成功）；1 校验失败（不写回）。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { zstdDecompressSync, zstdCompressSync, constants } from 'node:zlib'

const MAGIC = 0xfd2fb528
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_BASE = 0x184d2a50

/**
 * 用与宿主一致的帧参数压缩：**带 XXH64 校验和、不带 content size**（流式帧）。
 *
 * 实测：Node 默认参数会写出 `single_segment=1, checksum=0` 的帧，而 DSH 写的是
 * `single_segment=0, checksum=1`（descriptor 0x04）。参数不一致时宿主读不回来
 * ——会话会「消失」或继续报 corrupt。所以这里必须显式对齐。
 */
export function compressFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1, [constants.ZSTD_c_contentSizeFlag]: 0 },
  })
}

/** 解析 zstd 帧边界（只读帧头与块头，不解码数据）。 */
export function frameBounds(buf) {
  const bounds = []
  let p = 0
  while (p + 4 <= buf.length) {
    const start = p
    const magic = buf.readUInt32LE(p)
    if (magic === MAGIC) {
      p += 4
      const descriptor = buf[p]
      p += 1
      const fcsFlag = descriptor >> 6
      const singleSegment = (descriptor >> 5) & 1
      const checksum = (descriptor >> 2) & 1
      const dictIdFlag = descriptor & 3
      if (!singleSegment) p += 1
      p += [0, 1, 2, 4][dictIdFlag] ?? 0
      p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
      for (;;) {
        const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
        p += 3
        const last = header & 1
        const type = (header >> 1) & 3
        const size = header >>> 3
        p += type === 1 ? 1 : size
        if (last) break
      }
      if (checksum) p += 4
      bounds.push({ start, end: p })
      continue
    }
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_BASE) {
      const size = buf.readUInt32LE(p + 4)
      p += 8 + size
      bounds.push({ start, end: p, skippable: true })
      continue
    }
    throw new Error(`帧解析失败：偏移 ${p} 不是 zstd 帧头`)
  }
  return bounds
}

const SEQ_KEYS = new Set(['seq', 'headerSeq', 'startSeq', 'endSeq', 'sourceEventSeqs'])

/** 把 > drop 的 seq（及其引用）前移一位。 */
export function shiftSeq(value, drop, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'number' && item > drop && key === 'sourceEventSeqs' ? item - 1 : shiftSeq(item, drop),
    )
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && value > drop && SEQ_KEYS.has(key) ? value - 1 : value
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = shiftSeq(v, drop, k)
  return out
}

/** 重放校验：seq 连续；消息类事件若宿主严格（developer/message）必须落在打开的 turn/step 内。 */
export function validate(events, { strictTypes = ['developer/message'] } = {}) {
  const problems = []
  let turn = null
  let step = null
  let expected = 0
  for (const ev of events) {
    if (ev.type === 'session' && ev.seq === undefined) {
      expected = 0
      continue
    }
    if (ev.seq !== expected) problems.push(`seq 不连续：期望 ${expected}，实际 ${ev.seq}（${ev.type}）`)
    expected = ev.seq + 1
    const t = ev.type
    if (t === 'turn/start') {
      turn = ev.data?.turn ?? turn
      step = null
    } else if (t === 'step/start') {
      step = ev.data?.step ?? step
      turn = ev.data?.turn ?? turn
    } else if (t === 'step/end') step = null
    else if (t === 'turn/end') {
      turn = null
      step = null
    } else if (strictTypes.includes(t) && (turn === null || step === null)) {
      problems.push(`${t} seq ${ev.seq} 不在打开的 turn/step 内（turn=${turn} step=${step}）`)
    }
  }
  return problems
}

function main() {
  const [inPath, ...rest] = process.argv.slice(2)
  if (!inPath) {
    console.error('用法: node scripts/repair-session.mjs <session.v4.jsonl.zstd> [--drop-seq=N] [--apply]')
    process.exit(2)
  }
  // 2.9.46：本脚本的重编号漏改 compaction 的 shadowedRange/shadowedSeqs，会把
  // 「turn/step 不匹配」修成「prune span 不匹配」，而它自带的 validate() 又会打印「通过」。
  // 修日志请改用 doc/research/repair-v4.mjs（默认原地改类型、不动 seq、落盘后回读校验）；
  // 确需复现旧行为时才加 --legacy-unsafe。
  if (!rest.includes('--legacy-unsafe')) {
    console.error(
      [
        '拒绝执行：scripts/repair-session.mjs 已停用（重编号会漏改 compaction span，造出更难修的日志）。',
        '请改用：node "<仓库>/doc/research/repair-v4.mjs" <in.zstd> --apply [--out=<目标>]',
        '它默认原地把越界 developer/message 改成 user/message（seq 不动），并在落盘后回读校验。',
        '仅在复现旧行为/做对照实验时才追加 --legacy-unsafe。',
      ].join('\n'),
    )
    process.exit(2)
  }
  const dropArg = rest.find((a) => a.startsWith('--drop-seq='))
  const dropSeq = dropArg ? Number(dropArg.split('=')[1]) : NaN
  const apply = rest.includes('--apply')

  const raw = readFileSync(inPath)
  const bounds = frameBounds(raw)
  const texts = bounds.map((b) => (b.skippable ? '' : zstdDecompressSync(raw.subarray(b.start, b.end)).toString('utf8')))
  const events = texts.join('').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  console.log(`${inPath}\n  ${(raw.length / 1048576).toFixed(1)}MB / ${bounds.length} 帧 / ${events.length} 事件`)

  const before = validate(events)
  console.log(`  体检：${before.length ? before.length + ' 处问题' : '通过'}`)
  for (const p of before.slice(0, 6)) console.log('    - ' + p)

  if (!Number.isFinite(dropSeq)) {
    if (before.length) {
      const bad = [...new Set(before.map((p) => p.split(' ')[0]))]
      console.log(`\n只体检不改动。修复示例：--drop-seq=<越界事件的 seq> --apply`)
      console.log('提示：越界事件通常紧跟在 turn/end 之后，可用上面的行号定位。')
    }
    process.exit(0)
  }

  const idx = events.findIndex((e) => e.seq === dropSeq)
  if (idx < 0) {
    console.error(`找不到 seq=${dropSeq}`)
    process.exit(1)
  }
  console.log(`\n  丢弃 seq ${dropSeq}（${events[idx].type}）：${JSON.stringify(events[idx]).slice(0, 160)}`)
  const repaired = events.filter((_, i) => i !== idx).map((e) => shiftSeq(e, dropSeq))

  const after = validate(repaired)
  console.log(`  修复后校验：${after.length ? '失败' : '通过（seq 连续、严格类型违规 0）'}`)
  if (after.length) {
    for (const p of after.slice(0, 6)) console.log('    - ' + p)
    process.exit(1)
  }

  // 按原帧的行数分组重压，保持多帧结构。
  const counts = texts.map((t) => t.split('\n').filter((l) => l.trim()).length)
  const frames = []
  let cursor = 0
  for (const count of counts) {
    if (count === 0) continue
    const chunk = repaired.slice(cursor, cursor + count)
    cursor += chunk.length
    if (!chunk.length) continue
    frames.push(compressFrame(chunk.map((e) => JSON.stringify(e)).join('\n') + '\n'))
  }
  if (cursor < repaired.length) {
    frames.push(compressFrame(repaired.slice(cursor).map((e) => JSON.stringify(e)).join('\n')))
  }
  const out = Buffer.concat(frames)
  console.log(`  重建：${frames.length} 帧 / ${(out.length / 1048576).toFixed(1)}MB`)

  if (!apply) {
    console.log('\n  （未写回；加 --apply 生效）')
    process.exit(0)
  }
  const backup = `${inPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(inPath, backup)
  writeFileSync(inPath, out)
  console.log(`\n  已备份 ${backup}\n  已写回 ${inPath}`)
}

if (process.argv[1] && process.argv[1].endsWith('repair-session.mjs')) main()
