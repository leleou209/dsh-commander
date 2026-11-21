/**
 * 指挥员的 LLM 路由：把三个 `llm*` 配置收成宿主的 AgentOptions、枚举全部可用
 * 路由、校验一条路由是否真能用，以及决定用哪个 spawn 后端。
 *
 * 为什么单独一层：这些形状全是**实测**逼出来的（见每段注释），散在装配文件里
 * 既容易被顺手改掉，也看不见彼此的关系。装配只管"什么时候调"，判断都在这里。
 */

/**
 * 把三个 `llm*` 配置收成宿主的 `AgentOptions`。
 *
 * 只放**非空**字段：spawn 后端的语义是「覆盖父会话的对应项」，没给的继续继承，
 * 所以只配 model 不配 provider 是合法的（provider 沿用主会话）。
 * `override` 来自 `commander(action="recreate"/"rebuild")`，优先于配置。
 *
 * @returns {{provider?: string, model?: string, reasoningEffort?: string}|undefined}
 */
export function buildAgentOptions(config = {}, override) {
  const pick = (value) => (typeof value === 'string' ? value.trim() : '')
  const provider = pick(override?.provider) || pick(config.llmProvider)
  const model = pick(override?.model) || pick(config.llmModel)
  const reasoningEffort = pick(override?.reasoningEffort) || pick(config.llmReasoningEffort)
  const options = {}
  if (provider.length > 0) options.provider = provider
  if (model.length > 0) options.model = model
  if (reasoningEffort.length > 0) options.reasoningEffort = reasoningEffort
  return Object.keys(options).length === 0 ? undefined : options
}

/**
 * 后端顺序：只要决定了具体模型就必须走 spawn。
 *
 * fork 复用父会话逐字节相同的前缀、命中 KV cache（冷 spawn 实测要预填充
 * 269,237 token、57.4 秒出首字），但为保住缓存它会**主动丢弃模型选择参数**
 * （宿主源码：`Fork omits model-selection arguments for KV Cache reuse`）。
 * 传了也静默无效——这比报错危险，所以有 agentOptions 时只给 spawn。
 */
export function providerOrder(config, agentOptions) {
  if (agentOptions !== undefined) return ['spawn']
  const preferred = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'fork'
  return [...new Set([preferred, 'spawn'])]
}

/**
 * 枚举全部已注册 provider 的模型，进程内缓存一次（按 ctx 隔离：插件重载、
 * 假宿主并存的场合不该互相串）。
 *
 * `listModels` 对某些 provider 会发网络请求，而状态轮询是高频路径，
 * provider 列表在一次运行里基本不变。拉不到的 provider 直接跳过——
 * 没登录/离线不该拖垮整份清单。
 */
const routesCache = new WeakMap()

export async function collectModelRoutes(ctx) {
  const cached = routesCache.get(ctx)
  if (cached !== undefined) return cached
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.listProviders !== 'function') return undefined
  let providers = []
  try {
    providers = llm.listProviders() ?? []
  } catch {
    return undefined
  }
  const routes = []
  for (const provider of providers) {
    const id = provider?.id
    if (typeof id !== 'string' || id.length === 0) continue
    let models = []
    try {
      models = (await llm.listModels(id)) ?? []
    } catch {
      continue
    }
    for (const model of models) {
      if (typeof model?.id === 'string' && model.id.length > 0) routes.push({ provider: id, model: model.id })
    }
  }
  if (routes.length === 0) return undefined
  routesCache.set(ctx, routes)
  return routes
}

/**
 * 校验一条路由是否真的能用。
 *
 * `AgentModel.select()` 只追加事件、**不校验** provider/model/effort；而"配错了 effort"
 * 的代价不是报错，是指挥员**出生即坏**——每一轮都直接死在
 * `UNSUPPORTED_REASONING_EFFORT`（傀儡实测：预热 failed、0 步 0 工具，用户只看到
 * "预热失败"，看不出是配置写错）。
 *
 * `llm.resolveCallConfig()` 是宿主 `selectModel` 内部的同一个校验器，实测它连
 * reasoningEffort 也校验。这里用它把"出生即坏"提前挡住：
 *   - 换模型（用户显式指定）：不降级，原样把原因回给调用方；
 *   - 建指挥员（配置驱动）：effort 不支持就丢掉 effort 再验一次——能用比坏掉好。
 */
export async function probeRoute(ctx, route, { allowDropEffort = false } = {}) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') return { ok: true, route }
  const selection = (candidate) => {
    const out = { provider: candidate.provider, model: candidate.model }
    if (typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort.length > 0) {
      out.reasoningEffort = candidate.reasoningEffort
    }
    return out
  }
  try {
    await llm.resolveCallConfig(selection(route))
    return { ok: true, route }
  } catch (error) {
    const first = String(error?.message ?? error)
    if (!allowDropEffort || typeof route.reasoningEffort !== 'string' || route.reasoningEffort.length === 0) {
      return { ok: false, message: first }
    }
    const { reasoningEffort, ...rest } = route
    try {
      await llm.resolveCallConfig(selection(rest))
      return { ok: true, route: rest, dropped: reasoningEffort }
    } catch (again) {
      return { ok: false, message: String(again?.message ?? again) }
    }
  }
}
