/**
 * 自检（commander action=doctor）：一条命令说清"现在是健康还是哪里断了"。
 *
 * 2.9.38 P1 从 index.js 搬出。逻辑逐行未改，差异只有三处：
 *   - 依赖由工厂注入（t / config / pluginDir / pluginVersion / 各查询函数）；
 *   - `ctx.get('goals')` 改为注入的 `getGoal(agent)`；
 *   - `PLUGIN_DIR` 不再由 `import.meta.url` 推导（在 doctor.js 里那会指向 doctor.js
 *     自己），改由调用方传入真正的插件目录。
 *
 * 依赖方向：node 内置 + state-store/code-state；不反向 import index.js。
 */

import fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { computeCodeState, describeGitHead } from './code-state.js'
import { STATE_TABLES } from './state-store.js'

/**
 * @param {{
 *   t: (key: string, params?: any) => string,
 *   config: any,
 *   pluginDir?: string,
 *   pluginVersion: string,
 *   teamService: () => any,
 *   getGoal: (agent: any) => any,
 *   persistenceFacts: () => Promise<any>,
 *   currentTakeover: (agent: any) => { state: string },
 *   takeoverLine: (agent: any) => string,
 *   requiresConsultBeforeAsking: (state: string) => boolean,
 *   consultedSinceUser: Map<string, boolean>,
 *   uiWindowText: () => string,
 *   checkCatalog: () => Array<{ name: string }>,
 * }} deps
 */
export function createDoctor(deps) {
  const {
    t,
    config,
    pluginDir: PLUGIN_DIR,
    pluginVersion: PLUGIN_VERSION,
    teamService,
    getGoal,
    persistenceFacts,
    currentTakeover,
    takeoverLine,
    requiresConsultBeforeAsking,
    consultedSinceUser,
    uiWindowText,
    checkCatalog,
  } = deps

  // ---- doctor：一条命令说清"现在是健康还是哪里断了" ----

  /** 扫描 profile：`~/.dsh/profiles/<name>/node_modules/@local/dsh-commander` 指向哪里。 */
  async function profileMounts() {
    const roots = []
    const profilesDir = join(homedir(), '.dsh', 'profiles')
    let names = []
    try {
      names = await fsp.readdir(profilesDir)
    } catch {
      return roots
    }
    for (const name of names) {
      const link = join(profilesDir, name, 'node_modules', '@local', 'dsh-commander')
      try {
        const real = await fsp.realpath(link)
        roots.push({ profile: name, path: real })
      } catch {
        // 未安装
      }
    }
    return roots
  }

  /** 读某个目录下 package.json 的版本（读不到返回 undefined）。 */
  async function packageVersionAt(dir) {
    if (!dir) return undefined
    try {
      const raw = await fsp.readFile(join(dir, 'package.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed?.version === 'string' ? parsed.version : undefined
    } catch {
      return undefined
    }
  }

  /** commander(action=doctor)：PASS/WARN/FAIL 自检，默认只读。 */
  async function doctorReport(agent, cwd, options = {}) {
    const rows = []
    const add = (level, title, detail) => rows.push({ level, title, detail })
    const suggestions = []

    // 1) 版本与安装
    const mounts = await profileMounts()
    const diskVersion = await packageVersionAt(PLUGIN_DIR)
    let installDetail = `目录 ${PLUGIN_DIR ?? '未知'}，运行中 ${PLUGIN_VERSION}`
    if (diskVersion && diskVersion !== PLUGIN_VERSION) {
      installDetail += `，磁盘 package ${diskVersion}（重启后生效）`
    }
    const mountVersions = []
    for (const mount of mounts) mountVersions.push(await packageVersionAt(mount.path))
    const versionDrift = mounts.filter((_row, index) => mountVersions[index] && mountVersions[index] !== PLUGIN_VERSION)
    if (mounts.length === 0) {
      add('WARN', '安装', `${installDetail}；没有找到任何 profile 挂载（可能通过其他方式加载）`)
    } else {
      const normalized = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase()
      const mismatched = mounts.filter((row) => normalized(row.path) !== normalized(PLUGIN_DIR))
      if (mismatched.length > 0) {
        add(
          'FAIL',
          '安装',
          `${installDetail}；但 profile ${mismatched
            .map((row) => `${row.profile} → ${row.path}`)
            .join('、')} 指向别的目录，运行的不是这份代码`,
        )
        suggestions.push(t('doctor.suggest.mount'))
      } else if (versionDrift.length > 0 || (diskVersion && diskVersion !== PLUGIN_VERSION)) {
        // 目录一致但版本不一致：说明改了代码/换了包还没重启 —— 配置期望未满足，不是故障。
        add(
          'WARN',
          '安装',
          `${installDetail}；profile ${mounts.map((row) => row.profile).join('、')} 指向同一目录，但版本不一致（进程仍在跑旧代码，重启后生效）`,
        )
      } else {
        add('PASS', '安装', `${installDetail}；profile ${mounts.map((row) => row.profile).join('、')} 指向同一目录且版本一致`)
      }
    }

    // 2) 运行态
    let teammate
    try {
      const members = teamService().listMembers(agent)
      teammate = (Array.isArray(members) ? members : []).find(
        (member) => member.role === 'teammate' && member.name === config.commanderName,
      )
    } catch {
      teammate = undefined
    }
    const goal = (() => {
      try {
        return getGoal(agent)
      } catch {
        return undefined
      }
    })()
    add(
      teammate ? 'PASS' : 'WARN',
      '成员',
      teammate
        ? `${teammate.name}（${teammate.status ?? 'unknown'}，session=${teammate.id}）`
        : '尚未创建；用 /commander start 或直接发需求',
    )
    add(
      'PASS',
      'goal',
      goal ? `${goal.phase}（rounds ${goal.roundsStarted}/${goal.maxGoalRounds}）` : '当前会话没有 goal（正常）',
    )

    // 3) 持久化
    const persist = await persistenceFacts()
    const stateRows = []
    stateRows.push(persist.snapshot.exists ? `存在 ${persist.store.path}` : `未创建 ${persist.store.path}`)
    stateRows.push(`mode ${process.platform === 'win32' ? '不适用（Windows）' : (persist.mode ?? '未知')}`)
    stateRows.push(
      `表 ${STATE_TABLES.map((name) => `${name} ${persist.counts[name] ?? 0}`).join('，')}`,
    )
    if (persist.snapshot.lastWriteAt) {
      stateRows.push(`上次写入 ${new Date(persist.snapshot.lastWriteAt).toLocaleString(config.locale || 'zh-CN', { hour12: false })}`)
    }
    let writable = false
    try {
      await fsp.access(dirname(persist.store.path), 2)
      writable = true
    } catch {
      writable = false
    }
    stateRows.push(writable ? '可写 yes' : '可写 no')
    if (persist.snapshot.readError) stateRows.push(`读错误 ${persist.snapshot.readError}`)
    if (persist.snapshot.writeError) stateRows.push(`写错误 ${persist.snapshot.writeError}`)
    const persistLevel = !writable || persist.snapshot.writeError
      ? 'FAIL'
      : persist.snapshot.readError
        ? 'WARN'
        : persist.mode && persist.mode !== '600' && persist.mode !== '0600' && process.platform !== 'win32'
          ? 'WARN'
          : 'PASS'
    add(persistLevel, '持久化', stateRows.join('｜'))
    if (persist.snapshot.brokenFile) suggestions.push(t('doctor.suggest.stateBroken', { path: persist.snapshot.brokenFile }))
    if (persist.snapshot.lockBusy) suggestions.push(t('doctor.suggest.stateLock', { path: persist.store.lockPath }))
    if (persistLevel === 'WARN' && persist.mode && process.platform !== 'win32') suggestions.push(t('doctor.suggest.perm'))

    // 4) 门禁
    const leadId = agent?.session?.header?.id ?? agent?.id
    const gateOpen = consultedSinceUser.get(leadId) === true
    const takeoverNow = currentTakeover(agent)
    add('PASS', t('label.takeover'), takeoverLine(agent))
    add(
      'PASS',
      '问用户门禁',
      requiresConsultBeforeAsking(takeoverNow.state)
        ? gateOpen
          ? '全接管，但本轮已咨询（可问用户）'
          : '全接管：问用户前必须先 commander say + wait'
        : '不拦（当前接管状态不需要先咨询）',
    )

    // 5) UI 组件
    const windowText = uiWindowText()
    const windowMounted = windowText.startsWith('已挂载')
    // 未挂载只是「配置期望未满足」，不影响对话；只有真故障才 FAIL。
    const windowLevel = windowMounted ? 'PASS' : config.expectTranscriptWindow === true ? 'WARN' : 'PASS'
    add(windowLevel, '历史窗口', windowText)
    if (windowLevel === 'WARN') suggestions.push(t('doctor.suggest.window'))

    // 6) 环境
    let codeState
    try {
      codeState = await computeCodeState(cwd)
    } catch {
      codeState = '（无法计算）'
    }
    const checks = checkCatalog().length
    let commit = ''
    try {
      commit = await describeGitHead(cwd)
    } catch {
      commit = ''
    }
    add(
      'PASS',
      '环境',
      `cwd ${cwd}｜CODE_STATE ${codeState}${commit ? `｜提交 ${commit}（不绑定）` : ''}｜检查项 ${checks} 条`,
    )

    // 7) --fix
    const fixes = []
    if (options.fix === true) {
      const applied = await persist.store.fixPerms()
      fixes.push(...applied)
      const removed = persist.store.prune()
      if (removed > 0) fixes.push(`修剪 ${removed} 条历史记录`)
      await persist.store.flush()
    }

    const fails = rows.filter((row) => row.level === 'FAIL').length
    const warns = rows.filter((row) => row.level === 'WARN').length
    const out = [`## ${t('doctor.title')}`, '']
    for (const row of rows) {
      out.push(`- ${row.level} ${row.title}：${row.detail}`)
    }
    out.push('')
    out.push(
      fails > 0
        ? t('doctor.conclusionFail', { count: fails })
        : warns > 0
          ? t('doctor.conclusionWarn', { count: warns })
          : t('doctor.conclusionOk'),
    )
    if (suggestions.length > 0) {
      out.push(...suggestions.map((item) => `- 下一步：${item}`))
    }
    if (fixes.length > 0) out.push(`- ${t('doctor.fix.applied', { items: fixes.join('，') })}`)
    out.push('', 'First time, or unsure of the flow: `commander(action="help")` for the manual.')
    return { text: out.join('\n'), fails, warns }
  }
  return { doctorReport, profileMounts, packageVersionAt }
}
