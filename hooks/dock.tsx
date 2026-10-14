// Agent Dock: splits each request across a team of helper agents and shows each one as a live card.
// Every `$` call lives in this file; the logic it uses is in dock-logic.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { DockCard, DockState } from '../types'
import {
  BAD_NUMBER_COMMAND,
  BAD_NUMBER_TOAST,
  HEADSHOTS,
  HEADSHOT_DIR,
  canDrawImages,
  faceFor,
  CORAL,
  GOLD,
  GREEN,
  HAIRLINE,
  HELPER_PLAN_ANSWER,
  INK,
  NARROW_TOAST,
  PRESET_SIZES,
  RED,
  STOPPED_BEFORE_START,
  atOnce,
  badgeColor,
  badgeText,
  clampPercent,
  clock,
  closeIfFinished,
  countAgentCall,
  counts,
  denyText,
  emptyDock,
  finishCard,
  gradient,
  infoLine,
  initials,
  instructionText,
  isAcknowledgement,
  isFinished,
  isLive,
  layout,
  linkAgent,
  meterSegments,
  missionBar,
  missionPercent,
  mix,
  needsConfirm,
  newMission,
  nudgeText,
  parseSize,
  progressHelper,
  queueCard,
  restoreSize,
  seatColor,
  shouldNudge,
  startCard,
  summary,
  workingCount,
} from './dock-logic'

type Engine = EngineInterface

const PANE = 'agent-dock'
const PANE_COLUMNS = 84
const PROGRESS_TOOL = 'mcp__clean-view__report_progress'
const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const SIZE_KEY = 'dock.teamSize'
const MODEL_KEY = 'panel.helperModel'

const dockAtom = atom({ plugin: 'clean-view', key: 'dock' } as const, emptyDock())
const tickAtom = atom({ plugin: 'clean-view', key: 'dockTick' } as const, 0)

// Module variables start over on a hot reload; session.start puts them back.
let animation: Timer | null = null
let limit = 10
let lastWritten = -1
let statusPath: string | null = null
let faces: string[] = []
let isImageTerminal = false

async function safe<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

async function nowMs($: Engine): Promise<number> {
  return (await safe(() => $.clock.now())) ?? Date.now()
}

/** One 250ms clock, running only while helpers are queued or working. */
async function syncClock($: Engine, dock: DockState): Promise<void> {
  const live = isLive(dock.cards)
  if (live && animation === null) {
    animation =
      (await safe(() =>
        $.clock.every(250, () => {
          void safe(() => update($, tickAtom, n => (n + 1) % 1_000_000))
        }),
      )) ?? null
  } else if (!live && animation !== null) {
    animation.cancel()
    animation = null
  }
}

/** The status-bar badge and the live helper count your status line reads. */
async function publish($: Engine, dock: DockState): Promise<void> {
  const c = counts(dock.cards)
  const text = isLive(dock.cards)
    ? `◆ ${badgeText(c)}`
    : dock.mission?.finishedAt != null && c.total > 0
      ? `◆ ${c.total} done`
      : `◆ Dock · /dock`
  await safe(() => $.ui.status(text))

  if (c.working === lastWritten) return
  lastWritten = c.working
  await safe(async () => {
    if (statusPath === null) {
      const home = await $.env.get('HOME')
      const id = await $.session.id()
      if (!home) return
      const dir = `${home}/.claude/ai-employee-kit-data/agents-now`
      await $.process.run(['mkdir', '-p', dir])
      statusPath = `${dir}/${id}.json`
    }
    await $.fs.write(
      statusPath,
      JSON.stringify({ agents: c.working, queued: c.queued, done: c.done, stuck: c.stuck, updatedAt: Date.now() }),
    )
  })
}

async function edit($: Engine, fn: (dock: DockState) => DockState): Promise<DockState> {
  await update($, dockAtom, fn)
  const dock = await read($, dockAtom)
  await syncClock($, dock)
  await publish($, dock)
  return dock
}

async function openDock($: Engine): Promise<void> {
  const opened = await safe(() => $.ui.open({ id: PANE, title: 'Agent Dock', columns: PANE_COLUMNS }))
  if (opened && !opened.isPlaced) await safe(() => $.ui.toast(NARROW_TOAST))
}

async function toggleDock($: Engine): Promise<void> {
  const panes = (await safe(() => $.ui.panes())) ?? []
  if (panes.some(pane => pane.id === PANE)) await safe(() => $.ui.close({ id: PANE }))
  else await openDock($)
  await publish($, await read($, dockAtom))
}

/** Applies a size, or holds a big one for Continue / Cancel. */
async function chooseSize($: Engine, size: number): Promise<void> {
  if (needsConfirm(size)) {
    await edit($, d => ({ ...d, pendingSize: size, isCustomOpen: false }))
    return
  }
  await edit($, d => ({ ...d, teamSize: size, pendingSize: null, isCustomOpen: false }))
  await safe(() => $.store.set(SIZE_KEY, size))
}

async function confirmSize($: Engine): Promise<void> {
  const { pendingSize } = await read($, dockAtom)
  if (pendingSize === null) return
  await edit($, d => ({ ...d, teamSize: pendingSize, pendingSize: null }))
  await safe(() => $.store.set(SIZE_KEY, pendingSize))
  await safe(() => $.ui.toast(`Team Size is now ${pendingSize}`))
}

async function setModel($: Engine, model: DockState['helperModel']): Promise<void> {
  await edit($, d => ({ ...d, helperModel: model }))
  await safe(() => $.store.set(MODEL_KEY, model))
}

export function registerDock(on: On): void {
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const savedSize = await safe(() => $.store.get(SIZE_KEY))
    const savedModel = await safe(() => $.store.get(MODEL_KEY))
    const teamSize = restoreSize(savedSize)
    const helperModel = savedModel === 'same' ? 'same' : 'fast'
    limit = atOnce(
      await safe(() => $.env.get('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS')),
      await safe(() => $.env.get('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY')),
    )
    isImageTerminal = canDrawImages({
      term: await safe(() => $.env.get('TERM')),
      termProgram: await safe(() => $.env.get('TERM_PROGRAM')),
      kittyWindowId: await safe(() => $.env.get('KITTY_WINDOW_ID')),
      ghosttyResourcesDir: await safe(() => $.env.get('GHOSTTY_RESOURCES_DIR')),
      tmux: await safe(() => $.env.get('TMUX')),
    })
    const found: string[] = []
    for (const name of HEADSHOTS) {
      const file = `${$.plugin.root}/${HEADSHOT_DIR}/${name}.png`
      if (await safe(() => $.fs.exists(file))) found.push(file)
    }
    faces = found
    await edit($, d => ({ ...d, teamSize, helperModel, pendingSize: null }))
    await safe(() =>
      $.command.register({
        name: 'dock',
        description: 'Open or fold the Agent Dock, or set the Team Size (e.g. /dock 10)',
        argumentHint: '[team size]',
      }),
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- 1. Tell Claude to split the work ----------------------------------------

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind ?? 'composer'
    if (kind !== 'composer' && kind !== 'bridge' && kind !== 'sdk') return next(e)
    if (isAcknowledgement(e.text)) return next(e)
    const at = await nowMs($)
    const dock = await read($, dockAtom)
    if (!isLive(dock.cards)) await edit($, d => newMission(d, e.text, at, `m-${at}`))
    if (dock.teamSize <= 1) return next(e)
    return next({ ...e, context: [...(e.context ?? []), instructionText(dock.teamSize)] })
  }).catch(($, e, next) => next(e))

  // --- 4. Queued cards the moment Claude writes the Agent calls -----------------

  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const blocks = Array.isArray(e.message.content) ? e.message.content : []
      const calls = blocks.filter(
        (block): block is { type: 'tool_use'; id: string; name: string; input: { description?: unknown } } =>
          typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use' &&
          (block as { name?: string }).name === 'Agent',
      )
      if (calls.length > 0) {
        const at = await nowMs($)
        await edit($, d => calls.reduce((acc, call) => queueCard(acc, call.id, call.input?.description, at), d))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- 2 + 3 + 5. Cap, queue past the engine limit, helper model ---------------

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const id = e.tool_use_id
    const before = await read($, dockAtom)
    const size = before.teamSize

    if (size > 1 && before.mission !== null && before.mission.agentCalls >= size) {
      return { deny: denyText(size) }
    }

    const at = await nowMs($)
    await edit($, d => countAgentCall(queueCard(d, id, e.description, at)))

    // Hold the call until a slot frees. A `$` call's time never counts against the hook's budget.
    for (;;) {
      await update($, dockAtom, d => (workingCount(d) < limit ? startCard(d, id, at) : d))
      const now = await read($, dockAtom)
      if (now.cards.find(card => card.id === id)?.status === 'working') break
      if (next.signal.aborted) {
        const stoppedAt = await nowMs($)
        await edit($, d => finishCard(d, card => card.id === id, true, stoppedAt))
        return { deny: STOPPED_BEFORE_START }
      }
      await safe(() => $.process.run(['/bin/sleep', '1'], { timeoutMs: 5000 }))
    }
    const started = await read($, dockAtom)
    await syncClock($, started)
    await publish($, started)

    const useHaiku = size > 1 && started.helperModel === 'fast' && e.model === undefined
    const ran = await next(useHaiku ? { ...e, model: 'haiku' } : e)
    const endedAt = await nowMs($)

    if (ran.deny !== undefined || ran.isError === true) {
      await edit($, d => finishCard(d, card => card.id === id, true, endedAt))
      return ran
    }
    const record = ran.result as { agentId?: string; status?: string; totalDurationMs?: number } | undefined
    const agentId = record?.agentId
    const isComplete =
      record?.status === 'completed' || (record?.status === undefined && typeof record?.totalDurationMs === 'number')
    await edit($, d => {
      const linked = agentId ? linkAgent(d, id, agentId) : d
      return isComplete ? finishCard(linked, card => card.id === id, false, endedAt) : linked
    })
    return ran
  }).catch(($, e, next) => next(e))

  // --- 4. Helpers' progress reports and plans -----------------------------------

  on('tool.call', { tool: PROGRESS_TOOL, agentId: /./ }, async ($, e) => {
    const input = e as unknown as { task?: unknown; percent?: unknown; agentId?: string }
    const percent = clampPercent(input.percent)
    const at = await nowMs($)
    await edit($, d => progressHelper(d, String(input.agentId ?? ''), String(input.task ?? ''), percent, at))
    return { result: `Progress noted: ${percent}%.` }
  })

  on('tool.call', { tool: PLAN_TOOL, agentId: /./ }, () => ({ result: HELPER_PLAN_ANSWER }))

  // --- Helpers finishing, and the one follow-up per request ---------------------

  on('turn.complete', { reason: /^/ }, async ($, e, next) => {
    const at = await nowMs($)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await edit($, d => finishCard(d, card => card.agentId === agentId, e.reason !== 'answer', at))
      return next(e)
    }

    const dock = await read($, dockAtom)
    if (shouldNudge(dock.mission, dock.teamSize, e.isAborted || e.reason !== 'answer')) {
      const used = dock.mission?.agentCalls ?? 0
      await edit($, d => (d.mission ? { ...d, mission: { ...d.mission, hasNudged: true } } : d))
      void safe(() => $.prompt.submit({ text: nudgeText(used, dock.teamSize) }))
    } else if (dock.cards.length === 0) {
      await edit($, d => ({ ...d, mission: null }))
    } else {
      await edit($, d => closeIfFinished(d, at))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- 7. /dock ------------------------------------------------------------------

  on('command.run', { command: 'dock' }, async ($, e) => {
    try {
      const arg = (e.args ?? '').trim()
      if (arg === '') {
        void toggleDock($)
        return { text: 'Agent Dock: opened or folded. Type /dock again to switch.' }
      }
      const size = parseSize(arg)
      if (size === null) return { text: BAD_NUMBER_COMMAND }
      if (needsConfirm(size)) {
        void (async () => {
          await chooseSize($, size)
          await openDock($)
        })()
        return { text: `Confirm the team of ${size} in the Agent Dock.` }
      }
      void chooseSize($, size)
      return { text: `Team Size is now ${size}.` }
    } catch {
      return { text: 'The Agent Dock could not do that just now. Try /dock again.' }
    }
  })

  // --- The pane -------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const dock = await read($, dockAtom)
    const tick = await read($, tickAtom)
    const at = await nowMs($)
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = 'Input' in t ? t.Input : undefined
    const Image = e.surface === 'terminal' && 'Image' in t ? t.Image : undefined
    const useFaces = Image !== undefined && isImageTerminal && faces.length > 0
    const cols = Math.max(40, e.props.bodyColumns)
    const live = isLive(dock.cards)
    const finished = dock.mission !== null && isFinished(dock.cards)

    // Masthead
    const state = live
      ? { text: '● L I V E', color: tick % 8 < 5 ? GREEN : mix(GREEN, '#1A1C20', 0.55) }
      : finished
        ? { text: 'C O M P L E T E', color: GOLD }
        : { text: 'S T A N D I N G   B Y', color: INK }
    const masthead = (
      <Box flexDirection="row" justifyContent="space-between" width={cols}>
        <Text bold>
          {gradient('◆  A G E N T   D O C K').map(({ ch, color }) => (
            <Text color={color}>{ch}</Text>
          ))}
        </Text>
        <Text color={state.color} bold>
          {state.text}
        </Text>
      </Box>
    )
    const rule = <Text color={HAIRLINE}>{'─'.repeat(cols)}</Text>

    // Team Size
    const isPreset = (PRESET_SIZES as readonly number[]).includes(dock.teamSize)
    const chip = (key: string, label: string, isOn: boolean, onPress: () => void) => (
      <Button key={key} plain onPress={onPress}>
        {isOn ? (
          <Text backgroundColor={CORAL} color="#141518" bold>
            {` ${label} `}
          </Text>
        ) : (
          <Text color={INK}>{` ${label} `}</Text>
        )}
      </Button>
    )
    const sizeRow = (
      <Box flexDirection="row" flexWrap="wrap">
        <Text color={INK}>{'T E A M  S I Z E   '}</Text>
        <Text color={HAIRLINE}>╭</Text>
        {PRESET_SIZES.map(size =>
          chip(`size-${size}`, String(size), dock.teamSize === size && dock.pendingSize === null, () => {
            void chooseSize($, size)
          }),
        )}
        <Text color={HAIRLINE}>│</Text>
        {chip('size-custom', isPreset ? 'Custom' : `Custom ${dock.teamSize}`, !isPreset, () => {
          void edit($, d => ({ ...d, isCustomOpen: !d.isCustomOpen }))
        })}
        <Text color={HAIRLINE}>╮</Text>
      </Box>
    )
    const custom =
      dock.isCustomOpen && Input ? (
        <Box marginTop={1}>
          <Input
            key="custom-size"
            label="How many helpers?"
            placeholder="1 to 100"
            submitLabel="Set"
            autoFocus
            onSubmit={(value: string) => {
              const size = parseSize(value)
              if (size === null) void safe(() => $.ui.toast(BAD_NUMBER_TOAST))
              else void chooseSize($, size)
            }}
          />
        </Box>
      ) : null

    const info = <Text color={INK}>{infoLine(dock.teamSize, limit, dock.helperModel)}</Text>
    const modelRow = (
      <Box flexDirection="row">
        <Text color={INK}>{'Helper agents  '}</Text>
        {chip('model-fast', 'Fast & Cheap', dock.helperModel === 'fast', () => {
          void setModel($, 'fast')
        })}
        <Text> </Text>
        {chip('model-same', 'Same as me', dock.helperModel === 'same', () => {
          void setModel($, 'same')
        })}
      </Box>
    )

    const bigTeam =
      dock.pendingSize !== null ? (
        <Box borderStyle="round" borderColor={GOLD} paddingX={1} flexDirection="column" width={cols} marginTop={1}>
          <Text color={GOLD}>Big team: this uses your plan quickly. Continue?</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="big-continue" variant="primary" label={`Continue with ${dock.pendingSize}`} onPress={() => confirmSize($)} />
            <Button
              key="big-cancel"
              label="Cancel"
              onPress={() => {
                void edit($, d => ({ ...d, pendingSize: null }))
              }}
            />
          </Box>
        </Box>
      ) : null

    const header = (
      <Box flexDirection="column" width={cols}>
        {masthead}
        {rule}
        {sizeRow}
        {custom}
        {info}
        {modelRow}
        {bigTeam}
      </Box>
    )

    // Idle: the team standing by.
    if (dock.mission === null || dock.cards.length === 0) {
      const seats = Math.min(25, dock.teamSize)
      return (
        <Box flexDirection="column" width={cols}>
          {header}
          <Box marginTop={1} flexDirection="row">
            {Array.from({ length: seats }, (_, i) => (
              <Text color={seatColor(i, tick, live)}>{'● '}</Text>
            ))}
            {dock.teamSize > 25 && <Text color={INK}>{`+${dock.teamSize - 25}`}</Text>}
          </Box>
          <Text>{`Your team of ${dock.teamSize} is standing by`}</Text>
          <Text color={INK}>
            {dock.teamSize === 1
              ? 'Send a request and Claude decides how many helpers to use.'
              : `Send a request and it splits across ${dock.teamSize} helpers.`}
          </Text>
        </Box>
      )
    }

    // Mission bar
    const mission = dock.mission
    const percent = missionPercent(dock.cards)
    const elapsed = (mission.finishedAt ?? at) - mission.startedAt
    const right = `${percent}%   ${clock(elapsed)}`
    const titleRoom = Math.max(8, cols - 16 - right.length)
    const bar = missionBar(dock.cards, cols)
    const c = counts(dock.cards)
    const missionBlock = (
      <Box flexDirection="column" width={cols} marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text>
            <Text color={INK}>{'M I S S I O N   '}</Text>
            <Text bold>{mission.title.slice(0, titleRoom)}</Text>
          </Text>
          <Text color={finished ? GOLD : undefined}>{right}</Text>
        </Box>
        <Text>
          {gradient('━'.repeat(bar.done)).map(({ ch, color }) => (
            <Text color={color}>{ch}</Text>
          ))}
          <Text color={tick % 6 < 3 ? GREEN : mix(GREEN, '#FFFFFF', 0.25)}>{'━'.repeat(bar.working)}</Text>
          <Text color={HAIRLINE}>{'─'.repeat(bar.rest)}</Text>
        </Text>
        <Text>
          <Text color={GREEN}>{`● ${c.working} working`}</Text>
          <Text color={INK}>{`    ○ ${c.queued} queued`}</Text>
          <Text color={GOLD}>{`    ✓ ${c.done} done`}</Text>
          <Text color={c.stuck > 0 ? RED : INK}>{`    ✕ ${c.stuck} stuck`}</Text>
        </Text>
        {finished && (
          <Box borderStyle="round" borderColor={GREEN} paddingX={1} width={cols} marginTop={1}>
            <Text color={GREEN}>{summary(dock.cards, mission.title, elapsed)}</Text>
          </Box>
        )}
      </Box>
    )

    // Cards
    const shape = layout(dock.cards.length, cols)
    const timer = (card: DockCard) =>
      card.startedAt === null ? '—' : clock((card.finishedAt ?? at) - card.startedAt)
    const meterColor = (card: DockCard, kind: 'fill' | 'sweep' | 'rest') =>
      kind === 'rest' ? HAIRLINE : card.status === 'stuck' ? RED : card.status === 'done' ? GOLD : kind === 'sweep' ? GREEN : CORAL
    const meter = (card: DockCard, width: number) =>
      meterSegments(card, width, tick).map(segment => <Text color={meterColor(card, segment.kind)}>{segment.text}</Text>)
    const pct = (card: DockCard) => (card.status === 'queued' ? 'queued' : card.hasReported || card.status === 'done' ? `${card.percent}%` : '…')

    const badge = (card: DockCard) => (
      <Text backgroundColor={badgeColor(card.name)} color="#141518" bold>
        {initials(card.name)}
      </Text>
    )
    /** A headshot where the terminal draws pictures; null means use the badge. */
    const face = (card: DockCard, index: number, columns: number, rows: number) => {
      const file = useFaces ? faceFor(index, faces) : null
      if (Image === undefined || file === null) return null
      return <Image key={`face-${card.id}`} source={{ file, format: 'png' }} columns={columns} rows={rows} alt={initials(card.name)} />
    }

    const cardView = (card: DockCard, index: number) => {
      const dim = card.status === 'queued'
      const inner = shape.cardWidth - 4
      if (shape.isTiles) {
        const tileFace = face(card, index, 2, 1)
        return (
          <Box key={`card-${card.id}`} flexDirection="column" width={shape.cardWidth} marginRight={1} hover={{ backgroundColor: '#22252B' }}>
            <Box flexDirection="row">
              {tileFace ?? badge(card)}
              <Text dimColor={dim} color={card.status === 'stuck' ? RED : INK} wrap="truncate-end">{` ${timer(card)}`}</Text>
            </Box>
            <Text dimColor={dim}>{meter(card, shape.cardWidth - 1)}</Text>
          </Box>
        )
      }
      const time = timer(card)
      const nameRoom = Math.max(4, inner - 4 - time.length - 1)
      const name = card.name.length > nameRoom ? `${card.name.slice(0, nameRoom - 1)}…` : card.name.padEnd(nameRoom)
      const label = pct(card)
      const cardFace = face(card, index, 4, 2)
      if (cardFace !== null) {
        const room = inner - 5
        const faceName = card.name.length > room - time.length - 1 ? `${card.name.slice(0, Math.max(3, room - time.length - 2))}…` : card.name.padEnd(room - time.length - 1)
        return (
          <Box
            key={`card-${card.id}`}
            flexDirection="row"
            width={shape.cardWidth}
            borderStyle="round"
            borderColor={card.status === 'stuck' ? RED : HAIRLINE}
            hover={{ borderColor: CORAL }}
            paddingX={1}
          >
            {cardFace}
            <Box flexDirection="column" marginLeft={1}>
              <Text dimColor={dim} wrap="truncate-end">
                <Text bold={card.status === 'working'}>{`${faceName} `}</Text>
                <Text color={INK}>{time}</Text>
              </Text>
              <Text dimColor={dim} wrap="truncate-end">
                {meter(card, Math.max(4, room - label.length - 2))}
                <Text color={card.status === 'stuck' ? RED : INK}>{`  ${label}`}</Text>
              </Text>
            </Box>
          </Box>
        )
      }
      return (
        <Box
          key={`card-${card.id}`}
          flexDirection="column"
          width={shape.cardWidth}
          borderStyle="round"
          borderColor={card.status === 'stuck' ? RED : HAIRLINE}
          hover={{ borderColor: CORAL }}
          paddingX={1}
        >
          <Text dimColor={dim} wrap="truncate-end">
            {badge(card)}
            <Text bold={card.status === 'working'}>{`  ${name} `}</Text>
            <Text color={INK}>{time}</Text>
          </Text>
          <Text dimColor={dim} wrap="truncate-end">
            {'    '}
            {meter(card, Math.max(4, inner - 4 - label.length - 2))}
            <Text color={card.status === 'stuck' ? RED : INK}>{`  ${label}`}</Text>
          </Text>
        </Box>
      )
    }

    const rows: DockCard[][] = []
    for (let i = 0; i < dock.cards.length; i += shape.perRow) rows.push(dock.cards.slice(i, i + shape.perRow))

    return (
      <Box flexDirection="column" width={cols}>
        {header}
        {missionBlock}
        <Box flexDirection="column" marginTop={1}>
          {rows.map((row, i) => (
            <Box key={`row-${i}`} flexDirection="row" marginBottom={shape.isTiles ? 1 : 0}>
              {row.map((card, j) => cardView(card, i * shape.perRow + j))}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
