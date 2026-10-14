// Clean View: hides the technical rows and keeps one plain-English checklist above the prompt.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../types'
import {
  apiErrorSentence,
  applyPlan,
  applyProgress,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodos,
  clampPercent,
  cleanName,
  cleanTitle,
  emptyChecklist,
  finishAll,
  formatDuration,
  hasUnfinished,
  newJob,
} from './checklist'

type Engine = EngineInterface

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, emptyChecklist())
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const STORE_KEY = 'cleanViewEnabled'
export const PLAN_TOOL = 'mcp__clean-view__plan_steps'
export const PROGRESS_TOOL = 'mcp__clean-view__report_progress'
const ALWAYS_ALLOWED = new Set([
  PLAN_TOOL,
  PROGRESS_TOOL,
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
])

export const NEEDS_OK = 'Claude needs your OK to continue'
export const HAS_QUESTION = 'Claude has a question for you'
export const WAITING = 'Claude is waiting for your reply'
export const DENIED = 'you said no to a step, so Claude paused'
export const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
export const REFUSED = "Claude couldn't help with that request"
const REJECTED = /doesn't want to proceed|user rejected|was rejected|denied by the user|user (declined|denied)|permission .*denied/i

const STEP_RULES = `# Clean View is on
The person is using Clean View. They are not technical and do not see tool calls, diffs or command output: only a checklist of your steps above the prompt. Keep that checklist true and friendly.
- For every request, even a quick question, first call \`${PLAN_TOOL}\` with every step of the job, 2 to 8 short step names in order. If it is deferred, load it with ToolSearch first. Other tools are blocked until a plan exists.
- If this session has TodoWrite or TaskCreate, you may use your to-do list as the plan instead.
- Write every step name in plain English a non-technical person understands: under 40 characters, starting with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- As real progress happens, call \`${PROGRESS_TOOL}\` with the step's name and a percent, and with 100 the moment a step finishes.`

// Module variables start over on a hot reload; session.start puts the clock back.
let animation: Timer | null = null
let failures = 0
let lastApiError: { kind: string; details: string | null } | null = null

async function safe<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

async function now($: Engine): Promise<number> {
  return (await safe(() => $.clock.now())) ?? Date.now()
}

/** The 250ms clock runs only while a job is working or waiting on the person. */
async function syncClock($: Engine): Promise<void> {
  const list = await read($, checklistAtom)
  const enabled = await read($, enabledAtom)
  const animate = enabled && (list.phase === 'working' || list.phase === 'needsYou')
  if (animate && animation === null) {
    animation =
      (await safe(() =>
        $.clock.every(250, () => {
          void safe(() => update($, tickAtom, n => (n + 1) % 1_000_000))
        }),
      )) ?? null
  } else if (!animate && animation !== null) {
    animation.cancel()
    animation = null
  }
}

async function edit($: Engine, fn: (list: CleanViewChecklist) => CleanViewChecklist): Promise<void> {
  await update($, checklistAtom, fn)
  await syncClock($)
}

function scheduleCollapse($: Engine, jobId: number, ms: number): void {
  void safe(() =>
    $.clock.after(ms, () => {
      void edit($, list => (list.jobId === jobId && list.phase === 'done' ? { ...list, isCollapsed: true } : list))
    }),
  )
}

function withNeedsYou(list: CleanViewChecklist, reason: string): CleanViewChecklist {
  return list.phase === 'idle' ? list : { ...list, phase: 'needsYou', needsYouReason: reason }
}

function withoutNeedsYou(list: CleanViewChecklist): CleanViewChecklist {
  if (list.phase !== 'needsYou' || !list.isRunning) return list
  return { ...list, phase: 'working', needsYouReason: null }
}

function withStuck(list: CleanViewChecklist, reason: string): CleanViewChecklist {
  return list.phase === 'idle' ? list : { ...list, phase: 'stuck', stuckReason: reason, needsYouReason: null }
}

async function setEnabled($: Engine, isOn: boolean): Promise<void> {
  await update($, enabledAtom, () => isOn)
  await safe(() => $.store.set(STORE_KEY, isOn))
  await safe(() =>
    $.ui.toast(isOn ? 'Clean View is on: technical details are hidden' : 'Clean View is off: showing everything'),
  )
  await syncClock($)
}

async function toggle($: Engine): Promise<void> {
  await setEnabled($, !(await read($, enabledAtom)))
}

async function nameJob($: Engine, text: string, jobId: number): Promise<void> {
  const prompt = `Here is a request someone sent to an assistant:\n\n${text.slice(0, 2000)}\n\nName this job in 2 to 6 plain words that start with a verb, like "Build my landing page". No file names, code, quotes or punctuation. Reply with the name only.`
  const ask = (withEffort: boolean) =>
    $.model.complete({
      model: 'haiku',
      prompt,
      maxTokens: 30,
      timeoutMs: 15000,
      ...(withEffort ? { effort: 'low' as const } : {}),
    })
  let reply = await safe(() => ask(true))
  if (reply && !reply.isAnswered && reply.reason === 'api-error' && reply.error === 'invalid_request') {
    reply = await safe(() => ask(false))
  }
  if (!reply || !reply.isAnswered) return
  const title = cleanTitle(reply.text)
  if (title === null) return
  await update($, checklistAtom, list => (list.jobId === jobId ? { ...list, title } : list))
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    const stored = await safe(() => $.store.get(STORE_KEY))
    if (typeof stored === 'boolean') await update($, enabledAtom, () => stored)

    await safe(() =>
      $.tool.register({
        name: 'plan_steps',
        description:
          'Lay out every step of the job before doing anything else: 2 to 8 short step names, in order. Each is plain English a non-technical person understands, under 40 characters, starting with a verb ("Build the pricing section"), with no file names, paths, commands, code or tool names. The first step starts right away. Call this first for every request.',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 8,
              description: 'The steps, in order, 2 to 8 of them.',
            },
          },
          required: ['steps'],
        },
        isDeferred: false,
      }),
    )
    await safe(() =>
      $.tool.register({
        name: 'report_progress',
        description:
          'Report real progress on the current step: its plain-English name and a percent from 0 to 100. Report 100 the moment a step finishes; the next step then starts by itself.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The step name, as planned.' },
            percent: { type: 'number', description: 'How far along the step is, 0 to 100.' },
          },
          required: ['task', 'percent'],
        },
        isDeferred: false,
      }),
    )
    await safe(() =>
      $.command.register({
        name: 'simple',
        description: 'Turn Clean View on or off (no argument flips it)',
        argumentHint: 'on|off',
      }),
    )

    const list = await read($, checklistAtom)
    if (list.phase === 'done' && !list.isCollapsed) scheduleCollapse($, list.jobId, 5000)
    await syncClock($)

    return next(e)
  })

  // --- Turn it on and off -------------------------------------------------

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    const isOn = arg === 'on' ? true : arg === 'off' ? false : arg === '' ? !(await read($, enabledAtom)) : null
    if (isOn === null) return { text: 'Type /simple on or /simple off.' }
    await setEnabled($, isOn)
    return { text: isOn ? 'Clean View is on.' : 'Clean View is off.' }
  })

  // --- Make Claude plan in plain words -------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabledAtom))) return composed
    return {
      sections: [...composed.sections, { id: 'clean-view:plain-steps', text: STEP_RULES, scope: 'session' as const }],
    }
  })

  // --- Jobs ------------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    if (text === '' || text.startsWith('/')) return next(e)

    lastApiError = null
    failures = 0
    const at = await now($)
    const list = await read($, checklistAtom)

    if (list.isRunning) {
      // A prompt folded into the running turn is a reply.
      await edit($, withoutNeedsYou)
    } else if ((list.phase === 'needsYou' || list.phase === 'stuck') && list.hasPlan && hasUnfinished(list)) {
      // A reply to a job that was waiting carries on with the same plan.
      await edit($, l => ({ ...l, phase: 'working', needsYouReason: null, stuckReason: null, isRunning: true, isCollapsed: false }))
    } else {
      await edit($, l => newJob(l, at))
      const { jobId } = await read($, checklistAtom)
      void safe(() =>
        $.clock.after(0, () => {
          void safe(() => nameJob($, text, jobId))
        }),
      )
    }

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const list = await read($, checklistAtom)
    if (list.isRunning) {
      if (e.notification_type === 'permission_prompt' || /permission/i.test(e.message)) {
        await edit($, l => withNeedsYou(l, NEEDS_OK))
      } else if (e.notification_type === 'elicitation_dialog') {
        await edit($, l => withNeedsYou(l, HAS_QUESTION))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    lastApiError = { kind: String(e.error), details: e.error_details ?? null }
    await edit($, l => withStuck(l, apiErrorSentence(String(e.error), e.error_details ?? null)))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const at = await now($)
    const error = lastApiError

    await edit($, l => {
      if (l.phase === 'idle') return { ...l, isRunning: false }
      const base = { ...l, isRunning: false }
      if (e.reason === 'refusal') return withStuck(base, REFUSED)
      if (e.reason === 'error') {
        return withStuck(base, apiErrorSentence(error?.kind ?? 'unknown', error?.details ?? null))
      }
      if (l.stuckReason === DENIED) return { ...base, phase: 'stuck' }
      if (e.reason === 'aborted') return { ...base, phase: 'stopped', needsYouReason: null, finishedAt: at }
      if (l.hasPlan && hasUnfinished(l)) {
        return { ...base, phase: 'needsYou', needsYouReason: WAITING, stuckReason: null }
      }
      return finishAll(base, at)
    })

    const list = await read($, checklistAtom)
    if (list.phase === 'done') scheduleCollapse($, list.jobId, 5000)

    return next(e)
  })

  // --- Tool calls: gate, needs-you, failures, to-do lists --------------------
  // Registered before the tools' own hooks, so it sits outside them.

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    const enabled = await read($, enabledAtom)
    const before = await read($, checklistAtom)

    if (enabled && before.phase !== 'idle' && !before.hasPlan && !ALWAYS_ALLOWED.has(tool)) {
      return {
        deny: `Clean View: call ${PLAN_TOOL} first with 2 to 8 plain-English steps (load it with ToolSearch if it is deferred), then try this again.`,
      }
    }

    if (tool === 'AskUserQuestion') await edit($, l => withNeedsYou(l, HAS_QUESTION))
    else if (before.phase === 'needsYou') await edit($, withoutNeedsYou)

    const ran = await next(e)

    // The tool ran (or the question was answered): whatever needed the person is past.
    await edit($, withoutNeedsYou)

    if (ran.deny === undefined && ran.isError !== true) {
      if (e.tool === 'TodoWrite') {
        await edit($, l => applyTodos(l, e.todos))
      } else if (e.tool === 'TaskCreate') {
        const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
        const subject = e.subject
        await edit($, l => applyTaskCreate(l, subject, id))
      } else if (e.tool === 'TaskUpdate') {
        const { taskId, status, subject } = e
        await edit($, l => applyTaskUpdate(l, taskId, status, subject))
      }
    }

    if (ran.deny === undefined) {
      if (ran.isError === true) {
        const said = `${ran.text ?? ''} ${typeof ran.result === 'string' ? ran.result : ''}`
        if (REJECTED.test(said)) {
          failures = 0
          await edit($, l => withStuck(l, DENIED))
        } else {
          failures += 1
          if (failures >= 3) await edit($, l => withStuck(l, KEEPS_FAILING))
        }
      } else {
        failures = 0
        await edit($, l =>
          l.phase === 'stuck' ? { ...l, phase: l.isRunning ? 'working' : 'stuck', stuckReason: l.isRunning ? null : l.stuckReason } : l,
        )
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const raw = (e as unknown as { steps?: unknown }).steps
    const steps = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
    if (steps.length === 0) return { deny: 'plan_steps needs a list of 2 to 8 short step names.' }
    const at = await now($)
    await edit($, l => {
      const base = l.phase === 'idle' || l.phase === 'done' || l.phase === 'stopped' ? newJob(l, at) : l
      return { ...applyPlan(base, steps), phase: base.isRunning ? 'working' : base.phase, stuckReason: null }
    })
    const count = Math.min(8, steps.length)
    return { result: `Planned ${count} step${count === 1 ? '' : 's'}. The first one has started.` }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const input = e as unknown as { task?: unknown; percent?: unknown }
    const percent = clampPercent(input.percent)
    const task = typeof input.task === 'string' ? input.task : ''
    await edit($, l => applyProgress(l, task, percent))
    return { result: `Progress noted: ${percent}%.` }
  })

  // --- Hide the technical rows ------------------------------------------------

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // --- The band above the prompt ----------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const enabled = await read($, enabledAtom)
    const list = await read($, checklistAtom)
    const tick = await read($, tickAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = Math.max(20, e.props.bodyColumns)

    const button = (
      <Button
        key="clean-view-toggle"
        label={enabled ? '● Clean View: ON' : '○ Clean View: OFF'}
        onPress={() => toggle($)}
      />
    )
    const headerRow = (left: unknown) => (
      <Box flexDirection="row" justifyContent="space-between" width={columns}>
        <Box flexDirection="row" flexShrink={1}>
          {left as never}
        </Box>
        {button}
      </Box>
    )

    if (!enabled || list.phase === 'idle') {
      return headerRow(<Text> </Text>)
    }

    const at = await now($)
    const elapsed = formatDuration((list.finishedAt ?? at) - (list.startedAt ?? at))
    const title = list.title || 'Working on your request'

    let left
    switch (list.phase) {
      case 'needsYou':
        left = (
          <Text wrap="truncate-end">
            <Text inverse bold color="warning">
              {' Needs you '}
            </Text>{' '}
            {list.needsYouReason ?? NEEDS_OK}
          </Text>
        )
        break
      case 'stuck':
        left = (
          <Text color="warning" wrap="truncate-end">
            ⚠ Stuck: {list.stuckReason ?? KEEPS_FAILING}
          </Text>
        )
        break
      case 'stopped':
        left = <Text wrap="truncate-end">■ Stopped · {title} · you pressed Esc</Text>
        break
      case 'done':
        left = (
          <Text wrap="truncate-end">
            <Text color="success">✓ All done</Text> · {title} · took {elapsed}
          </Text>
        )
        break
      default:
        left = (
          <Text wrap="truncate-end">
            <Text bold>{title}</Text>
            <Text dimColor> · {elapsed}</Text>
          </Text>
        )
    }

    if (list.phase === 'done' && list.isCollapsed) return headerRow(left)

    const nameWidth = Math.max(6, columns - 2 - 1 - 10 - 2 - 7)
    const firstUpcoming = list.tasks.findIndex(task => task.status === 'upcoming')
    const isLive = list.phase === 'working' || list.phase === 'needsYou'

    const rows = list.tasks.map((task, i) => (
      <Box key={task.id} flexDirection="row">
        {(() => {
          const icon = taskIcon(task, list.phase)
          return (
            <Text color={icon.color} bold={icon.bold} dimColor={icon.dim}>
              {icon.glyph}
            </Text>
          )
        })()}
        <Text> </Text>
        <Text bold={task.status === 'active'} dimColor={task.status !== 'active'}>
          {fit(task.name, nameWidth)}
        </Text>
        <Text> </Text>
        <Text
          color={task.status === 'done' ? 'success' : task.status === 'active' ? 'claude' : undefined}
          dimColor={task.status === 'upcoming'}
        >
          {meter(task, tick, isLive)}
        </Text>
        <Text dimColor={task.status !== 'active'}>  {label(task, i === firstUpcoming)}</Text>
      </Box>
    ))

    return (
      <Box flexDirection="column" width={columns}>
        {headerRow(left)}
        {rows}
      </Box>
    )
  })
}

function taskIcon(task: CleanViewTask, phase: string): { glyph: string; color?: string; bold?: boolean; dim?: boolean } {
  if (task.status === 'done') return { glyph: '✓', color: 'success' }
  if (task.status === 'active') return { glyph: phase === 'needsYou' ? '‖' : '▶', bold: true }
  return { glyph: '○', dim: true }
}

function fit(name: string, width: number): string {
  const plain = cleanName(name)
  return plain.length > width ? `${plain.slice(0, Math.max(1, width - 1))}…` : plain.padEnd(width)
}

const CELLS = 10

function meter(task: CleanViewTask, tick: number, isLive: boolean): string {
  if (task.status === 'done') return '█'.repeat(CELLS)
  if (task.status === 'upcoming') return '░'.repeat(CELLS)
  if (task.hasReported) {
    const filled = Math.round(task.percent / 10)
    return '█'.repeat(filled) + '░'.repeat(CELLS - filled)
  }
  if (!isLive) return '░'.repeat(CELLS)
  // No percent yet: a three-cell sweep moving across the meter.
  const pos = (tick % (CELLS + 3)) - 3
  let out = ''
  for (let i = 0; i < CELLS; i += 1) out += i >= pos && i < pos + 3 ? '▓' : '░'
  return out
}

function label(task: CleanViewTask, isNext: boolean): string {
  if (task.status === 'done') return 'Done'
  if (task.status === 'active') return task.hasReported ? `${task.percent}%` : 'Working'
  return isNext ? 'Next' : 'Up next'
}
