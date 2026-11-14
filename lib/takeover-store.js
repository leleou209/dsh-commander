/**
 * 接管挡位的持久化（2.9.60）。
 *
 * 用户口径（2026-11-15）：**重启不该把挡位忘掉**。2.9.47 起挡位是纯内存态
 * （"重启不复活 full"），代价是每次重启都回到"不接管"，用户以为图标不认人。
 *
 * 只保存**挡位本身**，不碰 goal：
 *   - 恢复 full 只是把状态显示回 full，**恢复这个动作本身不触发一次交接驱动**
 *     （不会凭空开一轮）；之后正常的 turn/end 交接当然按 full 生效——那就是全接管的含义；
 *   - goal 仍然按"重新驱动权在用户"处理，不会被复活或续跑。
 *
 * 存在 state store 的 `takeover` 表：key = 根会话 id，value = `{state, source, at}`。
 * 读路径是同步的（`currentTakeover`），所以这里由 store **持有**那个 Map：
 * `ready()` 把磁盘灌进 Map，`set()` / `delete()` 双写（写盘失败只记日志，不影响交互）。
 */

/** 只接受合法挡位；脏数据一律丢弃（宁可回到默认，也不要半截状态）。 */
export function validTakeoverState(value) {
  return value === 'off' || value === 'observe' || value === 'partial' || value === 'full' ? value : undefined
}

/**
 * @param {{
 *   map: Map<string, {state: string, source?: string, at?: number}>,
 *   unit: () => Promise<any>,            // 状态存储单元（loadAll / putRecord / deleteRecord）
 *   log?: any,
 *   now?: () => number,
 * }} deps
 */
export function createTakeoverStore({ map, unit, log, now = Date.now }) {
  let readyPromise

  async function hydrate() {
    try {
      const u = await unit()
      if (u === undefined || u === null) return
      const all = await u.loadAll()
      const rows = all?.tables?.takeover
      if (rows === undefined || rows === null || typeof rows !== 'object') return
      for (const [rootId, record] of Object.entries(rows)) {
        const state = validTakeoverState(record?.state)
        // 内存里已经有更新的值（比如本次进程里刚切过）就不覆盖。
        if (state === undefined || map.has(rootId)) continue
        const source = typeof record?.source === 'string' && record.source.length > 0 ? record.source : 'user'
        const at = Number.isFinite(record?.at) ? Number(record.at) : now()
        map.set(rootId, { state, source, at })
      }
    } catch (error) {
      log?.warn?.(`dsh-commander: 接管挡位恢复失败：${error && error.message ? error.message : error}`)
    }
  }

  /** 恢复只做一次；调用方可以随便 await。 */
  const ready = () => {
    if (readyPromise === undefined) readyPromise = hydrate()
    return readyPromise
  }

  /** 写盘不挡交互：失败只记日志，下次切换会再试。 */
  const persist = (work) => {
    work().catch((error) => {
      log?.warn?.(`dsh-commander: 接管挡位保存失败：${error && error.message ? error.message : error}`)
    })
  }

  const record = (rootId, value) => ({
    state: value.state,
    source: typeof value.source === 'string' && value.source.length > 0 ? value.source : 'user',
    at: Number.isFinite(value.at) ? Number(value.at) : now(),
  })

  return {
    ready,
    /** 双写：先更新内存（同步读路径立刻看到），再异步落盘。 */
    set(rootId, value) {
      const row = record(rootId, value)
      map.set(rootId, row)
      persist(async () => (await unit())?.putRecord('takeover', rootId, row))
      return row
    },
    /** 清掉某个会话的挡位（`setTakeoverOverride(id, undefined)`）。 */
    delete(rootId) {
      map.delete(rootId)
      persist(async () => (await unit())?.deleteRecord('takeover', rootId))
    },
  }
}
