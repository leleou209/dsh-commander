/**
 * 用户可见文案目录。
 *
 * 规则（与 README「文案约定」一致）：
 *   - 每条按「发生了什么 + 影响 + 下一步」三段写；
 *   - 实现术语不进用户可见文本，只在日志里出现；
 *   - 前缀分级：`[信息]` / `[注意]` / `[失败]`；
 *   - 缺失 key 显式暴露为 `⟦missing:<key>⟧` 并 warn 一次，不静默回退成英文。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en']

const zhCN = {
  // ---- 前缀 ----
  'level.info': '[信息]',
  'level.warn': '[注意]',
  'level.error': '[失败]',

  // ---- help ----
  'help.usage1': '用法：/{cmd} <任意需求或问题>   ← 直接发给指挥员',
  'help.usage2': '      /{cmd} [start|list|status|doctor|checks [名称]|takeover [状态]|say <消息>|wait [请求号]|cancel [请求号]|record <摘要>|help]',
  'help.empty': '不带参数只显示本说明（不会创建指挥员或 goal）。',

  // ---- start ----
  'start.created': '指挥员已创建，可以开始对话了。',
  'start.ready': '指挥员已就绪（沿用同一个会话，不会新建卡片）。',
  'start.titleSkipped': '卡片标题未设置：该名字由宿主统一管理，改不了，不影响使用。',
  'start.modelFallback': '未指定专用模型，沿用当前 Agent Teams 路由。',

  // ---- status / doctor 标签 ----
  'status.title': '指挥员模式状态',
  'label.pluginVersion': '插件版本',
  'label.docsDir': '文档目录',
  'label.rounds': '已完成指挥轮次',
  'label.codeState': '当前代码状态',
  'label.persistence': '持久化',
  'label.lastDecision': '最后决定',
  'label.goal': 'goal',
  'label.teammate': '指挥员成员',
  'label.pending': '未完成请求',
  'label.approval': '允许结束放行',
  'label.goalApproval': 'goal 变更批准',
  'label.uiWindow': '历史窗口',
  'label.model': '指导模型',
  'label.askGate': '问用户门禁',

  // ---- 持久化 ----
  'persist.file': '文件 {path}',
  'persist.notWritten': '文件 {path}（尚未写入）',
  'persist.lastWrite': '上次写入 {time}',
  'persist.memory': '内存模式（写盘失败：{error}），重启会丢',
  'persist.readError': '读错误：{error}',
  'persist.writeError': '写错误：{error}',
  'persist.lockBusy': '另一个 DSH 进程正在写，本次跳过（不会覆盖对方数据）',
  'persist.migrated': '已从旧版本 {from} 迁移读取，数据保留',
  'persist.broken': '原文件损坏，已备份为 {path} 并以空状态继续',
  'persist.overLimit': '状态文件超过大小上限，已备份后重置',

  // ---- 门禁 / 批准 ----
  'gate.needCommander': '当前是全接管：先 commander(action=say) 说明卡点并请求「暂时作结」，再 wait；拿到「需澄清」+ 批准 pause 后，才暂停 goal、问用户、本轮结束。想直接问用户就先 /commander takeover partial。',
  'label.takeover': '接管状态',
  'label.handoff': '自动交接',
  'takeover.off': '不运行指挥职责（无指挥）',
  'takeover.observe': '不接管',
  'takeover.partial': '部分接管',
  'takeover.full': '全接管',
  'takeover.hint': '点开菜单选择：不运行指挥职责 / 不接管 / 部分接管 / 全接管',
  'takeover.offRefusal':
    '用户已切换至不指挥状态，指挥agent已休息，请自行思考。要恢复就先让用户把接管状态切回「不接管」以上。',
  'takeover.starting': '正在启动指挥员…',
  'takeover.announce.off':
    '[接管状态] 用户已把接管状态切为「不运行指挥职责（无指挥）」：指挥员休息，不要再用 commander(action=say/wait)，自己判断推进；要恢复指挥就等用户切回「不接管」以上。',
  'takeover.announce.observe':
    '[接管状态] 用户已把接管状态切为「不接管」：指挥员在场但只当顾问，goal 命令与问用户都不拦。',
  'takeover.announce.partial':
    '[接管状态] 用户已把接管状态切为「部分接管」：goal 的 complete/edit/pause/blocked 需要先取得指挥员批准；问用户不受限。',
  'takeover.announce.full':
    '[接管状态] 用户已把接管状态切为「全接管」：连问用户都要先 commander(action=say) 说明卡点并 wait；goal 命令同样需要批准。',
  'gate.needApproval': 'goal {action} 需要指挥员批准：先在汇报里请求，并取得「批准：goal {action}」。',
  'gate.needApprovalPhase': 'goal {action} 需要指挥员批准（当前阶段 {phase}；若批准已在 wait 里被插件执行，无需再调 update_goal）。',
  'gate.needRelease': '没有有效的「允许结束」放行，不能结束 goal：先 commander(action=wait) 取得放行。',
  'gate.resumeByUser': 'paused 的 goal 只能由你在界面上恢复；模型和指挥员都无权恢复。',

  // ---- goal 执行结果 ----
  'goal.applied': 'goal {action} 已由插件执行：{phase}（不需要再调用 update_goal）',
  'goal.failed': 'goal {action} 没有执行成功：{error}。可以重试，或让指挥员改发别的指令。',
  'goal.releaseRejected.missing': '放行未生效：回复里缺少「适用状态」这一行，无法确认针对哪次代码状态，请让指挥员重发。',
  'goal.releaseRejected.mismatch': '放行未生效：指挥员回显的代码状态与本次请求不一致（请求 {requested}，回复 {echoed}）。请用 status 里的「当前代码状态」原样回显。',
  'goal.releaseRejected.drift': '放行未生效：请求发出后代码已经变化（请求 {requested}，当前 {current}）。请重新汇报并取得新的放行。',
  'goal.bound': '本请求绑定的代码状态 = {codeState}（回显这一行才会放行）',

  // ---- doctor ----
  'doctor.title': '指挥员自检',
  'doctor.pass': 'PASS',
  'doctor.warn': 'WARN',
  'doctor.fail': 'FAIL',
  'doctor.conclusionOk': '结论：一切正常，无须处理。',
  'doctor.conclusionWarn': '结论：可用，但有 {count} 项需要注意。',
  'doctor.conclusionFail': '结论：有 {count} 项失败，按下面的建议处理后重试。',
  'doctor.suggest.mount': '安装目录与 profile 挂载不一致：用 plugin_manager 重新安装/切换一次，或重启 DSH。',
  'doctor.suggest.stateBroken': '状态文件损坏已备份：确认 {path} 无需要恢复的内容，或把它改名回 state.json 后重启。',
  'doctor.suggest.stateLock': '另一个 DSH 进程持有状态锁：停掉多余实例，或删除 {path}。',
  'doctor.suggest.perm': '权限过宽：运行 `/commander doctor --fix` 纠正为 0600/0700。',
  'doctor.suggest.gate': '问用户门禁收紧中：先 commander(action=say) 再 wait，之后才能问用户。',
  'doctor.suggest.window': '历史窗口未启用：这是默认设置，不影响功能；需要时再单独装 Client 侧窗口插件。',
  'doctor.fix.applied': '已纠正：{items}',

  // ---- checks ----
  'checks.empty': '没有配置检查项。请在插件配置 checkCommands 里加一条，例如 `offline = node test/offline.mjs`。',
  'checks.list': '可用检查项：\n{items}',
  'checks.unknown': '没有名为 {name} 的检查项；可用：{names}。',
  'checks.busy': '已有一个检查在运行，等它结束再试（并发上限 1）。',
  'checks.result': '检查 {name}：{status}，退出码 {exitCode}，耗时 {duration}。',
  'checks.timeout': '超时被终止（上限 {limit}s）',
  'checks.truncated': '（输出过长，只显示末尾 {lines} 行 / {bytes}B）',

  // ---- say / cancel ----
  'say.sent': '已投递给指挥员 {target}（请求 {requestId}）。',
  'say.sentImplicit': '已按咨询处理，直接投递给指挥员 {target}（请求 {requestId}）。',
  'say.next': '下一步：commander(action=wait) 无超时等待；若返回 interrupt，只验收别人已完成的工作，再次 wait。',
  'say.report': '汇报请含：轮次/指令、改动、验证命令与结果、问题/风险、代码版本。',
  'cancel.done': '已取消请求 {requestId}；指挥员即使继续运行也不会再恢复等待。',
  'cancel.none': '当前没有未完成的指挥请求。',

  // ---- pending / 陈旧 ----
  'pending.exists': '已有未完成的指挥请求 {requestId}；先 commander(action=wait) 等它完成，或 commander(action=cancel) 取消。',
  'pending.stale': '上一次请求 {requestId} 是上个进程遗留的（{waiting}s 前），指挥员的回复不会再来；已清理，重新 say 即可。',
  'pending.staleStatus': '陈旧（来自上个进程，可直接重新 say）',
  'pending.noMember': '找不到指挥员 "{name}"。当前成员：{names}。先调用 commander(action=start)。',
  'pending.disposed': '指挥员已退出，请求 {requestId} 终止；请检查 list_agents 后重新 say。',
  'pending.noRequestId': '指挥员回复缺少请求号，无法关联；本请求仍在等待。如确认未处理，可用 commander status / cancel。',
  'pending.emptyReply': '指挥员本轮结束，但没有文本回复。',
  'pending.interrupt': '工程组/子agent 完成：{sessionId}。只做验收/记录，不要分发新工作；处理完再次 commander(action=wait) 继续等待同一请求。',

  // ---- roster / status 缺省 ----
  'roster.title': '指挥员成员',
  'roster.teammate': 'teammate：{name}（status={status}，session={id}）',
  'roster.missing': '（尚未创建；调用 commander action=start 创建）',
  'roster.legacy': '历史指挥员子agent（可续接）',
  'roster.legacyHint': '历史卡片可用 commander(action=say, target="<id>") 续接；新建只会发生在没有任何可续接成员时。',
  'status.notCreated': '（未创建；调用 commander action=start）',
  'status.goalUnavailable': '（goal 服务不可用）',
  'status.goalReadFailed': '（读取失败：{error}）',
  'status.commit': '提交 {commit}（仅展示，不绑定放行）',

  // ---- goal 操作结果 ----
  'goal.opSucceeded': 'goal {action} 成功：{label}',
  'goal.opFailed': 'goal {action} 没有成功：{error}。可以重试，或换一个动作。',
  'goal.released': 'goal 已由指挥员放行并 complete（不需要再调用 update_goal）',
  'goal.completeFailed': 'goal complete 没有成功：{error}',
  'goal.kept': 'goal 已存在，保持原样未改动',
  'approval.misplaced': '批准行不在回复头部块，未生效：{actions}。请把批准行紧接在决定行之后、第一个空行之前。',
  'decision.missing': '（契约提醒：缺少「决定：继续 / 需澄清 / 允许结束」令牌，按无效回复处理；请要求指挥员重发。）',

  // ---- 命令错误 ----
  'command.unknownVerb': '未知子命令 "{raw}"，是不是想用 `{suggestion}`？',
  'command.unknownArg': '未识别的参数 "{raw}"。',
  'command.recordMissing': '缺少记录内容。',
  'command.failed': '指挥命令执行失败：{error}',

  // ---- 自动交接（handoff）正文 ----
  'handoff.reportHeader': '[自动交接] 主agent 已停下，以下是它本轮的最后输出。',
  'handoff.task': '当前任务：{task}',
  'handoff.noOutput': '（本轮没有可见输出）',
  'handoff.toolsHeader': '本轮工具：',
  'handoff.toolsMore': '…还有 {count} 条（未列）',
  'handoff.askNext': '请给下一步指令：继续 / 需澄清 / 允许结束。',
  'handoff.codeState': '代码状态：{codeState}',
  'handoff.instructionHeader': '[指挥员指令] 以下是指挥员对上一轮的回复，按它继续：',
  'handoff.emptyReply': '（指挥员回复为空）',
  'handoff.instructionNote':
    '注意：这是全接管下的自动交接，不要停下来问用户；进度以任务为单位汇报，不要用轮次计数。',
  'handoff.probeTag': '[探针]',
  'handoff.probeNote': '这是一次交接探针：请只确认收到并按正常格式回一句，不要据此派活或改状态。',

  // ---- 门禁 ----
  'gate.commanderReadOnly': '指挥员只能读取/侦察（可写文件但默认不动手）：工具 "{tool}" 被拒绝。请遵守契约，并在最终回答里给出「决定：继续/需澄清/允许结束」。',
}

const en = {
  'level.info': '[info]',
  'level.warn': '[warn]',
  'level.error': '[error]',
  'help.usage1': 'Usage: /{cmd} <any request or question>   ← goes straight to the commander',
  'help.usage2': '       /{cmd} [start|list|status|doctor|checks [name]|takeover [state]|say <message>|wait [requestId]|cancel [requestId]|record <summary>|help]',
  'help.empty': 'Without arguments this help is shown; no commander or goal is created.',
  'start.created': 'Commander created; you can start the conversation.',
  'start.ready': 'Commander ready (same session, no new card).',
  'start.titleSkipped': 'Card title not set: the host owns that name, so it cannot change. This does not affect usage.',
  'start.modelFallback': 'No dedicated model configured; the current Agent Teams route is used.',
  'status.title': 'Commander status',
  'label.pluginVersion': 'Plugin version',
  'label.docsDir': 'Docs directory',
  'label.rounds': 'Completed rounds',
  'label.codeState': 'Current code state',
  'label.persistence': 'Persistence',
  'label.lastDecision': 'Last decision',
  'label.goal': 'Goal',
  'label.teammate': 'Commander member',
  'label.pending': 'Pending request',
  'label.approval': 'Release grant',
  'label.goalApproval': 'Goal change approval',
  'label.uiWindow': 'Transcript window',
  'label.model': 'Advisor model',
  'label.askGate': 'Ask-user gate',
  'persist.file': 'file {path}',
  'persist.notWritten': 'file {path} (nothing written yet)',
  'persist.lastWrite': 'last write {time}',
  'persist.memory': 'in-memory (write failed: {error}); lost on restart',
  'persist.readError': 'read error: {error}',
  'persist.writeError': 'write error: {error}',
  'persist.lockBusy': 'another DSH process is writing; skipped to avoid overwriting it',
  'persist.migrated': 'read from older version {from}; data preserved',
  'persist.broken': 'state file was corrupt; backed up to {path} and continued empty',
  'persist.overLimit': 'state file exceeds the size limit; backed up and reset',
  'gate.needCommander': 'Full takeover is active: commander(action=say) to report the blocker and request a pause, then wait. Only after a clarification decision plus a pause approval may you pause the goal, ask the user, and end the turn. To ask directly, run /commander takeover partial first.',
  'label.takeover': 'Takeover',
  'label.handoff': 'Auto handoff',
  'takeover.off': 'Not running commander duties',
  'takeover.observe': 'Observe',
  'takeover.partial': 'Partial',
  'takeover.full': 'Full',
  'takeover.hint': 'Open the menu: not running duties / observe / partial / full',
  'takeover.offRefusal':
    'The user switched to no-commander mode; the commander is resting. Think it through yourself. To restore it, the user must switch takeover back to "observe" or higher.',
  'takeover.starting': 'Starting the commander…',
  'takeover.announce.off':
    '[Takeover] The user switched takeover to "not running commander duties": the commander is resting. Do not call commander(action=say/wait); decide and proceed yourself. To restore it, wait for the user to switch back to "observe" or higher.',
  'takeover.announce.observe':
    '[Takeover] The user switched takeover to "observe": the commander is present as an advisor only; goal commands and user questions are unrestricted.',
  'takeover.announce.partial':
    '[Takeover] The user switched takeover to "partial": goal complete/edit/pause/blocked need commander approval first; asking the user is unrestricted.',
  'takeover.announce.full':
    '[Takeover] The user switched takeover to "full": even asking the user must first go through commander(action=say) and wait; goal commands also need approval.',
  'gate.needApproval': 'goal {action} needs commander approval: request it in a report and obtain "批准：goal {action}".',
  'gate.needApprovalPhase': 'goal {action} needs commander approval (current phase {phase}; if the approval was already applied during wait, do not call update_goal again).',
  'gate.needRelease': 'No valid "允许结束" release; cannot end the goal. Use commander(action=wait) to obtain one.',
  'gate.resumeByUser': 'A paused goal can only be resumed by the user in the UI; neither the model nor the commander may resume it.',
  'goal.applied': 'goal {action} was applied by the plugin: {phase} (no need to call update_goal)',
  'goal.failed': 'goal {action} did not apply: {error}. Retry, or ask the commander for a different instruction.',
  'goal.releaseRejected.missing': 'Release not applied: the reply lacks the code-state line, so it cannot be bound. Ask the commander to resend.',
  'goal.releaseRejected.mismatch': 'Release not applied: the echoed code state differs from the request (requested {requested}, echoed {echoed}). Echo the value from status verbatim.',
  'goal.releaseRejected.drift': 'Release not applied: the code changed after the request (requested {requested}, current {current}). Report again for a fresh release.',
  'goal.bound': 'This request is bound to code state = {codeState} (echo this line to be released)',
  'doctor.title': 'Commander self-check',
  'doctor.pass': 'PASS',
  'doctor.warn': 'WARN',
  'doctor.fail': 'FAIL',
  'doctor.conclusionOk': 'Conclusion: all good, nothing to do.',
  'doctor.conclusionWarn': 'Conclusion: usable, {count} item(s) worth attention.',
  'doctor.conclusionFail': 'Conclusion: {count} item(s) failed; follow the suggestions below and retry.',
  'doctor.suggest.mount': 'Install directory and profile mount disagree: reinstall or switch once with plugin_manager, or restart DSH.',
  'doctor.suggest.stateBroken': 'State file was corrupt and backed up: confirm {path} has nothing to recover, or rename it back and restart.',
  'doctor.suggest.stateLock': 'Another DSH process holds the state lock: stop the extra instance, or delete {path}.',
  'doctor.suggest.perm': 'Permissions too broad: run `/commander doctor --fix` to restore 0600/0700.',
  'doctor.suggest.gate': 'Ask-user gate is closed: call commander(action=say) then wait before asking the user.',
  'doctor.suggest.window': 'Transcript window is off: this is the default and harmless; install a client-side window plugin if needed.',
  'doctor.fix.applied': 'Fixed: {items}',
  'checks.empty': 'No checks configured. Add one to checkCommands, e.g. `offline = node test/offline.mjs`.',
  'checks.list': 'Available checks:\n{items}',
  'checks.unknown': 'No check named {name}; available: {names}.',
  'checks.busy': 'A check is already running; wait for it (concurrency 1).',
  'checks.result': 'Check {name}: {status}, exit {exitCode}, took {duration}.',
  'checks.timeout': 'killed after {limit}s',
  'checks.truncated': '(output too long; showing the last {lines} lines / {bytes}B)',
  'say.sent': 'Sent to the commander {target} (request {requestId}).',
  'say.sentImplicit': 'Treated as a consultation and sent to {target} (request {requestId}).',
  'say.next': 'Next: commander(action=wait) waits without timeout; on interrupt, verify only the finished work, then wait again.',
  'say.report': 'Report: round/instruction, changes, verification commands and results, risks, code version.',
  'cancel.done': 'Cancelled request {requestId}; the commander will not resume the wait.',
  'cancel.none': 'No unfinished request.',
  'pending.exists': 'An unfinished request {requestId} exists; commander(action=wait) for it, or commander(action=cancel).',
  'pending.stale': 'Request {requestId} was left over from a previous process ({waiting}s ago); no reply will arrive. Cleared — say again.',
  'pending.staleStatus': 'stale (left over from a previous process; say again)',
  'pending.noMember': 'Commander "{name}" not found. Current members: {names}. Call commander(action=start) first.',
  'pending.disposed': 'The commander exited, so request {requestId} ended; check list_agents and say again.',
  'pending.noRequestId': 'The reply has no request id, so it cannot be matched; still waiting. Check commander status / cancel if needed.',
  'pending.emptyReply': 'The commander turn ended without a text reply.',
  'pending.interrupt': 'A team member finished: {sessionId}. Only verify/record; do not dispatch new work. Call commander(action=wait) again for the same request.',
  'roster.title': 'Commander members',
  'roster.teammate': 'teammate: {name} (status={status}, session={id})',
  'roster.missing': '(not created; call commander action=start)',
  'roster.legacy': 'Legacy commander sub-agents (continuable)',
  'roster.legacyHint': 'Continue a legacy card with commander(action=say, target="<id>"); a new one is created only when nothing is continuable.',
  'status.notCreated': '(not created; call commander action=start)',
  'status.goalUnavailable': '(goals service unavailable)',
  'status.goalReadFailed': '(read failed: {error})',
  'status.commit': 'commit {commit} (display only, not bound to releases)',
  'goal.opSucceeded': 'goal {action} succeeded: {label}',
  'goal.opFailed': 'goal {action} did not apply: {error}. Retry, or pick another action.',
  'goal.released': 'The commander released and completed the goal (no need to call update_goal)',
  'goal.completeFailed': 'goal complete did not apply: {error}',
  'goal.kept': 'goal already existed and was left unchanged',
  'approval.misplaced': 'Approval line is outside the header block and was ignored: {actions}. Put it right after the decision line, before the first blank line.',
  'decision.missing': '(contract: the reply lacks a 决定：继续 / 需澄清 / 允许结束 token, so it is invalid; ask the commander to resend.)',
  'command.unknownVerb': 'Unknown subcommand "{raw}"; did you mean `{suggestion}`?',
  'command.unknownArg': 'Unrecognised argument "{raw}".',
  'command.recordMissing': 'Nothing to record.',
  'command.failed': 'Command failed: {error}',
  'handoff.reportHeader': '[Handoff] The main agent stopped; below is its final output for this turn.',
  'handoff.task': 'Current task: {task}',
  'handoff.noOutput': '(no visible output this turn)',
  'handoff.toolsHeader': 'Tools this turn:',
  'handoff.toolsMore': '…plus {count} more (not listed)',
  'handoff.askNext': 'Give the next instruction: 继续 / 需澄清 / 允许结束 (continue / need clarification / allow finishing).',
  'handoff.codeState': 'Code state: {codeState}',
  'handoff.instructionHeader': '[Commander instruction] The commander replied to the previous turn; continue accordingly:',
  'handoff.emptyReply': '(the commander reply was empty)',
  'handoff.instructionNote':
    'Note: this is an automatic handoff under full takeover. Do not stop to ask the user; report progress per task, not per round count.',
  'handoff.probeTag': '[probe]',
  'handoff.probeNote': 'This is a handoff probe: just acknowledge receipt and reply in the normal format; do not dispatch work or change state based on it.',

  'gate.commanderReadOnly': 'The commander may only read/inspect (writing files is allowed but discouraged): tool "{tool}" was refused. Follow the contract and end with 决定：继续/需澄清/允许结束.',
}

const CATALOG = { 'zh-CN': zhCN, en }

/** 归一化语言标签：`zh`/`zh-Hans`/`zh_CN` → `zh-CN`；其他退回 `en`。 */
export function resolveLocale(input) {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) return 'zh-CN'
  if (raw.startsWith('zh')) return 'zh-CN'
  if (raw.startsWith('en')) return 'en'
  return 'zh-CN'
}

/**
 * 生成取文案函数。
 * @param {string} [locale]
 * @param {{onMissing?: (key: string) => void}} [options]
 */
export function createTranslator(locale, options = {}) {
  const primary = resolveLocale(locale)
  const fallback = primary === 'zh-CN' ? 'en' : 'en'
  const missing = new Set()
  return function t(key, params) {
    const table = CATALOG[primary] ?? CATALOG.en
    const fb = CATALOG[fallback] ?? CATALOG.en
    const template = table[key] ?? fb[key]
    if (template === undefined) {
      if (!missing.has(key)) {
        missing.add(key)
        options.onMissing?.(key)
      }
      return `⟦missing:${key}⟧`
    }
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (_match, name) =>
      params[name] === undefined ? `{${name}}` : String(params[name]),
    )
  }
}

/** 供测试/doctor 用：某语言的 key 列表。 */
export function messageKeys(locale = 'zh-CN') {
  return Object.keys(CATALOG[resolveLocale(locale)] ?? {})
}

/** 供测试用：检查两种语言 key 是否一致。 */
export function localeKeyDiff() {
  const zh = new Set(Object.keys(zhCN))
  const other = new Set(Object.keys(en))
  return {
    missingInEn: [...zh].filter((key) => !other.has(key)),
    missingInZh: [...other].filter((key) => !zh.has(key)),
  }
}