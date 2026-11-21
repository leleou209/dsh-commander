/**
 * 重建 / 销毁指挥员。
 *
 * **换模型不是运行时能力**：模型写在子会话的 `subagent/descriptor` 上，
 * 而日志只能追加、读取时只认第一条 descriptor——宿主没有"改已有子会话模型"的
 * 合法表示。插件早先试的那条侧路（往会话 append `model/selection`）当场能用，
 * 但每换一次就多一条 selection、宿主 resume 时又补一个 `session/end-seed`，
 * 累积几次后那个子会话再也加载不起来（实测 `subagent "…" is unavailable`），
 * **此后任何方式都无法再和它说话**。所以这里只保留"拆旧建新"。
 *
 * 代价是上下文重置；换来的是会话永远可恢复。用户可见的文案必须如实说明这一点。
 */

export function createRouteOps(app, deps) {
  const { ctx, store } = app
  const { probeRoute } = deps

  /**
   * 拆旧建新。先验路由再拆——坏路由一旦先落盘，就会出现
   * "好指挥员被拆了、留下的值又用不了"，比不换更难收拾。
   * 重建中途失败则把路由回滚，不把会话钉在一个没建成的模型上。
   */
  const rebuild = async (agent, route, signal) => {
    const rootId = app.rootIdOf(agent)
    const previous = store.route(rootId)
    if (route !== undefined) {
      const probed = await probeRoute(ctx, route)
      if (probed.ok !== true) return { ok: false, reason: 'unknown-route', message: probed.message }
      store.setRoute(rootId, route)
    }
    const disposed = await app.disposeCommander(rootId, signal)
    if (disposed.ok !== true && disposed.reason !== 'not-found' && disposed.reason !== 'forgotten') {
      store.setRoute(rootId, previous)
      return { ok: false, reason: disposed.reason ?? 'dispose-failed', message: disposed.message }
    }
    try {
      const spawned = await app.ensureCommander(agent, signal)
      return { ok: true, rebuilt: true, id: spawned?.id, route: store.route(rootId) }
    } catch (error) {
      store.setRoute(rootId, previous)
      return { ok: false, reason: 'start-failed', message: String(error?.message ?? error) }
    }
  }

  // 返回的是**绑定在 app 上**的方法：内部互相调用必须走 app.*，
  // 否则 Object.assign 之后再往里打补丁（测试就是这么干的）就看不见。
  return {
    rebuildCommander: rebuild,
    // `recreate` 是同一件事的旧名字，保留以免调用方突然报"方法不存在"。
    recreateCommander: rebuild,
  }
}
