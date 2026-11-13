/**
 * Main-agent manual (single source of truth).
 *
 * Why a separate module:
 *   - the tool description can only hold "what it is + actions + hard gates"; the
 *     full protocol does not fit;
 *   - a freshly installed agent must be able to fetch the full flow on demand,
 *     otherwise it can only guess (every pitfall below was hit for real).
 *
 * Usage:
 *   commander(action="help")               -> index (one line per topic + when to read it)
 *   commander(action="help", topic="loop") -> that section
 *
 * Constraints:
 *   - pure data + pure functions, no host deps, no timestamps, so it is unit-testable
 *     and can be rendered into `AGENT-MANUAL.md`;
 *   - English only: English is cheaper per token than Chinese for the same content.
 *     The contract tokens (`决定：` / `批准：` / `允许结束`) stay Chinese on purpose —
 *     they are protocol literals matched by `classifyReply()`, not prose;
 *   - usage only, no implementation detail; exact errors come from the tool results.
 */

/**
 * Tool description seen by the main agent (resident context: keep it short).
 *
 * Only "what it is + actions + hard gates + where to go next"; the full protocol
 * lives in the topics below (`commander(action="help")`). `test/manual.mjs` caps
 * this at 800 characters.
 */
export const COMMANDER_TOOL_DESCRIPTION =
  'Commander mode: a long-lived, resumable Agent Teams teammate (designer + supervising commander). Reads the whole workspace, runs read-only shell, may write docs but does not implement. ' +
  'action: start adopt; list members; say consult (registers a requestId); wait untimed wait; cancel; goal manage; status; doctor self-check; checks controlled checks; handoff probe; help manual (optional topic). ' +
  'Hard gates: complete a goal only after the commander explicitly says 允许结束; goal complete/edit/pause/blocked need 批准：goal <action>; under full takeover ask the user only after say + wait. ' +
  'Unsure? commander(action="help") first.'

/** Manual sections. Order = index order = AGENT-MANUAL.md chapter order. */
export const MANUAL_TOPICS = [
  {
    id: 'overview',
    title: 'What it is, what it is not',
    when: 'first time using it, or unsure whether to ask it at all',
    body: [
      'The commander is a long-lived, resumable teammate: a mid-level designer plus supervising commander. It reads the whole workspace, runs read-only shell, and may write docs but does not implement by default.',
      '',
      '- **It gives direction and acceptance, not implementation**: it decides where you are, what to do next, and whether this round passes. You or the engineering team implement.',
      '- **It is not a proxy for the user**: the user can interrupt or change the takeover state at any time. Its "continue" is not user consent — check the takeover state.',
      '- **One per session**, reused across turns. `action="start"` creates or adopts; it does not create a new card every round.',
      '- **It is resumable**: `action="list"` finds existing members, and `action="say", target="<id>"` re-attaches a legacy one.',
    ].join('\n'),
  },
  {
    id: 'states',
    title: 'Takeover states: who holds the wheel',
    when: 'deciding whether you may ask the user or finish a goal yourself',
    body: [
      'The user picks the state from the composer icon; **you cannot change it** (no action does that). The state decides which gates apply:',
      '',
      '| state | meaning | asking the user | goal complete/edit/pause/blocked | auto handoff each turn |',
      '| --- | --- | --- | --- | --- |',
      '| `off` not running commander duties | the commander sleeps | free | free | no |',
      '| `observe` | advisor only | free | free | no |',
      '| `partial` (default) | owns goal gates and releases | free | needs approval | no |',
      '| `full` | you are away; the commander speaks for the user | **say + wait first** | needs approval | **yes** |',
      '',
      '- Under `off`, `say` and `wait` are refused with "the user switched to no-commander mode". Decide and proceed yourself; do not retry.',
      '- The state lives **in memory only**: a plugin reload or process restart returns it to `partial`. If the commander suddenly "comes back", that is why — not a bug.',
      '- Unsure which state you are in: `action="status"` shows it on the first screen.',
    ].join('\n'),
  },
  {
    id: 'loop',
    title: 'One round: say -> wait -> branch',
    when: 'about to consult, or you got a reply and do not know the next step',
    body: [
      'The standard loop (works under `partial` and `full`):',
      '',
      '1. **When to report**: a new task or phase starts, an acceptance point is reached, or a real fork needs a decision. Do not report after every edit.',
      '2. `commander(action="say", message=<report>)` returns a requestId.',
      '3. `commander(action="wait")` waits without timeout. An `interrupt` means a team member finished: **verify only the finished work**, do not dispatch new work, then `wait` again for the same request.',
      '4. Branch on the `决定：` line in the reply header:',
      '   - `继续` (continue) -> do it. Small question or bug: answer or fix directly. Directional or multi-step work: finish a batch, then report.',
      '   - `需澄清` (needs clarification) -> only now may you call `ask_user_question` (or fill the gap it named).',
      '   - `允许结束` (allow finishing) -> only now may you `update_goal complete`. If the plugin already applied it (`goal.applied`), do not call it again.',
      '',
      'One request at a time: `pending.exists` means an unfinished request is still open — `wait` or `cancel` it; do not `say` concurrently.',
    ].join('\n'),
  },
  {
    id: 'tokens',
    title: 'Contract tokens and approval lines',
    when: 'a reply was rejected, a release did not apply, or you need to know the header format',
    body: [
      'Only the reply header block — everything **before the first blank line** — is parsed:',
      '',
      '```',
      '决定：继续 | 需澄清 | 允许结束      (continue / need clarification / allow finishing)',
      '批准：goal complete                 (only when approval is needed; right after the decision line)',
      '请求：req-…                         (echo of the request id; missing means no match)',
      '适用状态：CS-…                      (echo verbatim to be released)',
      '```',
      '',
      '- **Keep these tokens in Chinese, exactly as shown.** They are protocol literals matched by code, not prose; translating them breaks matching.',
      '- A reply without a `决定：` token is invalid (the tool says so).',
      '- An approval line outside the header block is ignored (the tool says so).',
      '- A release is bound to the code state: if you change code after the request, the release is void (requested vs current is reported). Report again for a fresh one.',
      '- **Do not forge tokens**: writing `决定：…` inside your own message produces no release.',
    ].join('\n'),
  },
  {
    id: 'goal',
    title: 'Goal gates and three hard rules',
    when: 'about to complete/pause/edit a goal, or a goal command failed',
    body: [
      '- Under `partial` / `full`, `update_goal` with `complete` / `edit` / `pause` / `blocked` needs `批准：goal <action>`.',
      '- `commander(action="goal", goalAction=…)` goes through **the same gates** as `update_goal`; it is not a back door.',
      '- A `paused` goal can only be resumed by the user in the UI: neither the model nor the commander may resume it.',
      '- The plugin may already have applied the goal operation during `wait` (the result says `goal.applied` with the phase) — **do not call `update_goal` again**.',
      '- With no goal in the session, goal commands fail with "no goal"; check `action="status"` before creating one.',
    ].join('\n'),
  },
  {
    id: 'full',
    title: 'Full takeover: the driver changes',
    when: 'the user switched to full takeover, or you notice you were woken automatically',
    body: [
      '`full` is not "more gates" — it is a **change of driver**:',
      '',
      '- Every time you end a turn, the plugin hands your final output plus this turn\'s tool summary to the commander.',
      '- Its instruction comes back as `[Commander instruction] …` and **automatically starts the next turn** — you do not `say` manually, and you do not wait for the user to press enter.',
      '- **Do not stop to ask the user**: the gate refuses it and tells you to `say` + `wait` first.',
      '- A user message means this round is **not** handed off (one yield); the state is unchanged and the next turn end continues as usual.',
      '- "Allow finishing" stops the driving, but the state stays `full` until you or the user change it.',
      '- **No round limit**: only the commander declaring completion ends it. An interruption is just an interruption and never changes the state. Only the user can stop it, by changing the state.',
      '',
      'How to tell you were auto-woken: the message starts with `[Commander instruction]` and no user spoke.',
    ].join('\n'),
  },
  {
    id: 'report',
    title: 'What a report contains (five items)',
    when: 'about to say, or a report came back as "not enough information"',
    body: [
      '1. **Round / instruction**: what this round does (use the task name, not "round N").',
      '2. **Changes**: which files, which behavior.',
      '3. **Verification commands and results**: paste the command and the real output; never just "verified".',
      '4. **Problems / risks**: known limits, unverified parts, decisions needed.',
      '5. **Code version**: commit / version / whether the tree is clean.',
      '',
      'Lead with the conclusion, then the evidence. Do not paste whole logs.',
    ].join('\n'),
  },
  {
    id: 'troubleshoot',
    title: 'Diagnose: probe first, do not guess',
    when: 'something looks broken, a handoff did not fire, or the state looks wrong',
    body: [
      'Check in this order; every step has a definite output, so do not change code to test a theory:',
      '',
      '1. `commander(action="doctor")` — health in one command (PASS/WARN/FAIL + next step). `fix=true` also repairs permissions.',
      '2. `commander(action="checks")` — list or run the configured controlled checks (e.g. test suites); `name` picks one.',
      '3. `commander(action="status")` — pending, releases, goal, takeover state, transcript window, last decision.',
      '4. `commander(action="handoff", probe="checks")` — handoff preconditions plus `lastSkip` / `lastError`: **the condition that failed is written there**. `probe="send"` sends one real report (tagged `[probe]`, dispatches nothing, leaves no pending).',
      '',
      'Common returns and what to do:',
      '',
      '- `pending.exists` -> an unfinished request is open; `wait` or `cancel` it.',
      '- `pending.noMember` -> the commander does not exist yet; `action="start"`.',
      '- `pending.disposed` -> the commander exited and the request ended; `say` again.',
      '- `pending.stale` -> left over from a previous process and already cleared; `say` again.',
      '- `decision.missing` -> the reply lacks the token; ask the commander to resend; do not patch it yourself.',
    ].join('\n'),
  },
  {
    id: 'antipatterns',
    title: 'Anti-patterns (all seen for real)',
    when: 'you are about to take a shortcut or bypass a gate',
    body: [
      '- **Bypassing the gate to ask the user**: refused under `full`. `say` the blocker, request a wrap-up, then ask.',
      '- **Calling `update_goal` after the plugin already applied the operation**: duplicate work; `goal.applied` means stop.',
      '- **Claiming "verified" without evidence**: paste the command and the result, or say "unverified".',
      '- **Re-asking what the user already answered**: read `doc/suggest.md`, `doc/history.md`, and the current context first.',
      '- **Recommending "pause / wait for instructions / stop for now"**: the commander forbids it unless the user asked.',
      '- **Reporting in round counts** ("round 3"): report per task.',
      '- **Dispatching new work when `wait` returns `interrupt`**: verify what finished, then `wait` again.',
      '- **Changing the takeover state yourself**: there is no action for it; it is the user\'s switch.',
    ].join('\n'),
  },
]

/** Index line budget (so adding topics cannot turn the index into the manual). */
export const MANUAL_INDEX_MAX_LINES = 30

/** Topic ids. */
export function manualTopicIds() {
  return MANUAL_TOPICS.map((topic) => topic.id)
}

/** One topic by id (undefined when missing). */
export function manualTopic(id) {
  const key = String(id ?? '').trim().toLowerCase()
  return MANUAL_TOPICS.find((topic) => topic.id === key)
}

/**
 * Index: one line per topic plus "when to read it".
 * @param {{header?: string, unknown?: string}} [options]
 */
export function renderManualIndex(options = {}) {
  const lines = [options.header ?? '## Commander manual (index)', '']
  for (const topic of MANUAL_TOPICS) {
    lines.push(`- **${topic.id}**: ${topic.title} — read when: ${topic.when}`)
  }
  lines.push('', 'Get a section: `commander(action="help", topic="<id>")`.')
  if (options.unknown) lines.push('', options.unknown)
  return lines.join('\n')
}

/** Body of one topic (undefined when missing; the caller decides how to answer). */
export function renderManualTopic(id) {
  const topic = manualTopic(id)
  if (!topic) return undefined
  return [`## ${topic.title}`, '', topic.body].join('\n')
}

/** Full `AGENT-MANUAL.md` content (deterministic, byte-compared by tests). */
export function renderManualMarkdown() {
  const lines = [
    '# Commander manual (for the main agent)',
    '',
    '> Generated from `manual.js` — **do not edit by hand**; change `manual.js` and regenerate.',
    '> A running agent gets the same content from `commander(action="help")` (add `topic` for one section).',
    '',
    '## Index',
    '',
  ]
  for (const topic of MANUAL_TOPICS) {
    lines.push(`- [${topic.title}](#${topic.id}) — read when: ${topic.when}`)
  }
  lines.push('')
  for (const topic of MANUAL_TOPICS) {
    lines.push(`<a id="${topic.id}"></a>`, '', `## ${topic.title}`, '', topic.body, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
