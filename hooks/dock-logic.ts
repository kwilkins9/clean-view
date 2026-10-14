// Agent Dock: every piece of logic that needs no `$`, so the tests can call it directly.
import type { DockCard, DockMission, DockState } from '../types'

export const MIN_SIZE = 1
export const MAX_SIZE = 100
export const BIG_TEAM = 20
export const PRESET_SIZES = [1, 3, 5, 10, 20, 50, 100] as const
export const DEFAULT_SUBAGENT_LIMIT = 20
export const DEFAULT_TOOL_LIMIT = 10
export const TILE_THRESHOLD = 12

export const BAD_NUMBER_TOAST = 'Type a whole number from 1 to 100'
export const BAD_NUMBER_COMMAND = 'Team Size is a whole number from 1 to 100, e.g. /dock 10.'
export const STOPPED_BEFORE_START = 'Stopped before this helper started.'
export const HELPER_PLAN_ANSWER = 'Helpers skip the plan. Just call report_progress as you work.'
export const NARROW_TOAST = 'The window is too narrow to show the Agent Dock. Widen it or watch the status bar.'

/** A whole number from 1 to 100, or null. */
export function parseSize(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= MIN_SIZE && n <= MAX_SIZE ? n : null
}

/** A saved size as a new session reads it: big teams never carry over. */
export function restoreSize(saved: unknown): number {
  const n = typeof saved === 'number' ? parseSize(String(saved)) : parseSize(saved)
  if (n === null || n > BIG_TEAM) return 1
  return n
}

export function needsConfirm(size: number): boolean {
  return size > BIG_TEAM
}

/** How many helpers run at once: the lower of the two engine limits. */
export function atOnce(subagentLimit: string | undefined, toolLimit: string | undefined): number {
  const read = (raw: string | undefined, fallback: number) => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
  }
  return Math.min(read(subagentLimit, DEFAULT_SUBAGENT_LIMIT), read(toolLimit, DEFAULT_TOOL_LIMIT))
}

export function modelLabel(model: DockState['helperModel']): string {
  return model === 'fast' ? 'Fast & Cheap' : 'Same model as you'
}

export function infoLine(size: number, limit: number, model: DockState['helperModel']): string {
  const split = size === 1 ? 'Claude decides how many helpers' : `Splits each request across ${size} helpers`
  return `${split}  ·  ${Math.min(limit, size === 1 ? limit : size)} at a time  ·  ${modelLabel(model)}`
}

const MAX_JOB = 40

function trimWords(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The job's name: the first clause of the request, about 40 characters. */
export function jobName(request: string): string {
  const plain = String(request ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const clause = (plain.split(/[.!?;:\n]|,\s|\s[-–—]\s/)[0] ?? '')
    .replace(/^(please|can you|could you|would you|hey|hi|ok|okay)[\s,]+/i, '')
    .replace(/^(please)\s+/i, '')
    .trim()
  if (clause === '') return 'Your request'
  return capitalise(trimWords(clause, MAX_JOB))
}

/** A helper's task name: 3 to 5 plain words. */
export function taskName(description: unknown): string {
  const words = String(description ?? '')
    .replace(/`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter(word => word !== '' && !word.includes('/'))
  if (words.length === 0) return 'Helper task'
  return capitalise(trimWords(words.slice(0, 5).join(' '), 32))
}

/** Two letters for a helper's badge: "Price check: Panera" → "PP". */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return '··'
  const first = words[0]?.charAt(0) ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : (words[0]?.charAt(1) ?? '')
  return (first + last).toUpperCase()
}

export function instructionText(size: number): string {
  return [
    `Team Size is ${size}. Split this request into exactly ${size} independent pieces and launch one helper (the Agent tool) per piece, all in one message so they run in parallel.`,
    'Find a real split, one helper per item (per store, per task, per file, per section). Never argue that it cannot be split and never pad with useless work.',
    'Give each helper a short plain-English description of 3 to 5 words, e.g. "Price check: Panera".',
    'In each helper\'s prompt add: "As you work, call report_progress with your task name and a percent at about 25, 50, 75 and 100. Do not call plan_steps."',
    'When they finish, combine their results into one answer.',
  ].join('\n')
}

export function denyText(size: number): string {
  return `Team Size is ${size}: this request already has ${size} helpers. Finish with the helpers you have.`
}

export function nudgeText(used: number, size: number): string {
  return `You used ${used} of ${size} helpers. Split the remaining work across the other ${size - used}, one helper per piece, all in parallel.`
}

export function shouldNudge(mission: DockMission | null, size: number, wasAborted: boolean): boolean {
  if (mission === null || size <= 1 || wasAborted) return false
  return !mission.hasNudged && mission.agentCalls < size
}

export type DockCounts = { working: number; queued: number; done: number; stuck: number; total: number }

export function counts(cards: readonly DockCard[]): DockCounts {
  const out = { working: 0, queued: 0, done: 0, stuck: 0, total: cards.length }
  for (const card of cards) out[card.status] += 1
  return out
}

export function isLive(cards: readonly DockCard[]): boolean {
  return cards.some(card => card.status === 'queued' || card.status === 'working')
}

export function isFinished(cards: readonly DockCard[]): boolean {
  return cards.length > 0 && !isLive(cards)
}

export function badgeText(c: DockCounts): string {
  const parts = [`${c.working} working`, `${c.queued} queued`, `${c.done} done`]
  if (c.stuck > 0) parts.push(`${c.stuck} stuck`)
  return parts.join(' · ')
}

/** "1:12", "12:03", "1:02:03". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** "2m 14s", "45s". */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  return m === 0 ? `${total % 60}s` : `${m}m ${total % 60}s`
}

export function summary(cards: readonly DockCard[], job: string, ms: number): string {
  const c = counts(cards)
  const noun = c.total === 1 ? 'agent' : 'agents'
  const stuck = c.stuck > 0 ? ` (${c.stuck} got stuck)` : ''
  return `${c.total} ${noun} finished ${job} in ${duration(ms)}${stuck}`
}

/** Overall percent: done and stuck count whole, working counts its own percent. */
export function missionPercent(cards: readonly DockCard[]): number {
  if (cards.length === 0) return 0
  const sum = cards.reduce((acc, card) => {
    if (card.status === 'done' || card.status === 'stuck') return acc + 100
    if (card.status === 'working') return acc + card.percent
    return acc
  }, 0)
  return Math.round(sum / cards.length)
}

export function clampPercent(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

const CELL = '━'
const HAIR = '─'

export type MeterSegment = { text: string; kind: 'fill' | 'sweep' | 'rest' }

/** A meter as segments: filled to the reported percent, or a moving sweep before the first report. */
export function meterSegments(card: DockCard, width: number, tick: number): MeterSegment[] {
  const w = Math.max(4, width)
  const filledTo = (percent: number): MeterSegment[] => {
    const filled = Math.round((percent / 100) * w)
    return [
      { text: CELL.repeat(filled), kind: 'fill' },
      { text: HAIR.repeat(w - filled), kind: 'rest' },
    ]
  }
  if (card.status === 'done') return filledTo(100)
  if (card.status === 'queued') return filledTo(0)
  if (card.status === 'stuck' || card.hasReported) return filledTo(card.percent)
  const span = Math.max(2, Math.round(w / 5))
  const pos = (tick % (w + span)) - span
  const start = Math.max(0, pos)
  const end = Math.max(start, Math.min(w, pos + span))
  return [
    { text: HAIR.repeat(start), kind: 'rest' },
    { text: CELL.repeat(end - start), kind: 'sweep' },
    { text: HAIR.repeat(w - end), kind: 'rest' },
  ]
}

/** The mission bar's widths: done, working and the rest, adding up to `width`. */
export function missionBar(cards: readonly DockCard[], width: number): { done: number; working: number; rest: number } {
  if (cards.length === 0) return { done: 0, working: 0, rest: width }
  const c = counts(cards)
  const workingShare = cards.filter(card => card.status === 'working').reduce((acc, card) => acc + card.percent, 0) / 100
  const done = Math.round(((c.done + c.stuck) / c.total) * width)
  const working = Math.min(width - done, Math.round((workingShare / c.total) * width))
  return { done, working, rest: Math.max(0, width - done - working) }
}

/** How many cards fit across: tiles past 12 helpers, else two or three cards. */
export function layout(total: number, columns: number): { isTiles: boolean; perRow: number; cardWidth: number } {
  if (total > TILE_THRESHOLD) {
    const tile = 13
    const perRow = Math.max(1, Math.floor((columns + 1) / (tile + 1)))
    return { isTiles: true, perRow, cardWidth: tile }
  }
  const perRow = columns >= 100 ? 3 : columns >= 64 ? 2 : 1
  const cardWidth = Math.max(24, Math.floor((columns - (perRow - 1)) / perRow))
  return { isTiles: false, perRow, cardWidth }
}

// --- Colour -------------------------------------------------------------------

export const CORAL = '#FF7A59'
export const GOLD = '#F5C26B'
export const GREEN = '#4ADE80'
export const RED = '#F87171'
export const INK = '#8B8F98'
export const HAIRLINE = '#3A3D44'

function hex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
}

/** A colour `t` of the way from `a` to `b` (both #RRGGBB). */
export function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16))
  return `#${pa.map((v, i) => hex(v + ((pb[i] ?? v) - v) * t)).join('')}`
}

/** One colour per character, coral fading to gold. */
export function gradient(text: string, from = CORAL, to = GOLD): Array<{ ch: string; color: string }> {
  const chars = [...text]
  return chars.map((ch, i) => ({ ch, color: mix(from, to, chars.length <= 1 ? 0 : i / (chars.length - 1)) }))
}

/** A calm seat colour for team member `i`, along the coral–gold line. */
export function seatColor(i: number, tick: number, isTwinkling: boolean): string {
  const base = mix(CORAL, GOLD, ((i * 37) % 100) / 100)
  if (!isTwinkling) return base
  const phase = (tick + i * 3) % 24
  return phase < 3 ? mix(base, '#FFFFFF', 0.35) : base
}

export function badgeColor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return mix(CORAL, GOLD, (hash % 100) / 100)
}

export function spaced(text: string): string {
  return [...text].join(' ')
}

// --- State transitions --------------------------------------------------------

export function emptyDock(): DockState {
  return {
    teamSize: 1,
    pendingSize: null,
    isCustomOpen: false,
    helperModel: 'fast',
    mission: null,
    cards: [],
  }
}

export function newMission(dock: DockState, request: string, now: number, id: string): DockState {
  return {
    ...dock,
    mission: { id, title: jobName(request), startedAt: now, finishedAt: null, agentCalls: 0, hasNudged: false },
    cards: [],
  }
}

function ensureMission(dock: DockState, now: number): DockState {
  if (dock.mission !== null && dock.mission.finishedAt === null) return dock
  if (dock.mission !== null && dock.mission.finishedAt !== null) {
    // A finished mission that gets new helpers starts a fresh count but keeps its name.
    return { ...dock, mission: { ...dock.mission, startedAt: now, finishedAt: null, agentCalls: 0 }, cards: [] }
  }
  return newMission(dock, 'Your request', now, `m-${now}`)
}

export function queueCard(dock: DockState, id: string, description: unknown, now: number): DockState {
  if (dock.cards.some(card => card.id === id)) return dock
  const base = ensureMission(dock, now)
  const card: DockCard = {
    id,
    agentId: null,
    name: taskName(description),
    status: 'queued',
    percent: 0,
    hasReported: false,
    startedAt: null,
    finishedAt: null,
  }
  return { ...base, cards: [...base.cards, card] }
}

export function countAgentCall(dock: DockState): DockState {
  if (dock.mission === null) return dock
  return { ...dock, mission: { ...dock.mission, agentCalls: dock.mission.agentCalls + 1 } }
}

function patch(dock: DockState, find: (card: DockCard) => boolean, fn: (card: DockCard) => DockCard): DockState {
  let hit = false
  const cards = dock.cards.map(card => {
    if (hit || !find(card)) return card
    hit = true
    return fn(card)
  })
  return hit ? { ...dock, cards } : dock
}

export function startCard(dock: DockState, id: string, now: number): DockState {
  return patch(dock, card => card.id === id, card => ({ ...card, status: 'working', startedAt: card.startedAt ?? now }))
}

export function linkAgent(dock: DockState, id: string, agentId: string): DockState {
  return patch(dock, card => card.id === id, card => ({ ...card, agentId }))
}

export function finishCard(dock: DockState, find: (card: DockCard) => boolean, isStuck: boolean, now: number): DockState {
  const next = patch(dock, find, card =>
    card.status === 'done' || card.status === 'stuck'
      ? card
      : {
          ...card,
          status: isStuck ? 'stuck' : 'done',
          percent: isStuck ? card.percent : 100,
          hasReported: true,
          startedAt: card.startedAt ?? now,
          finishedAt: now,
        },
  )
  return closeIfFinished(next, now)
}

export function closeIfFinished(dock: DockState, now: number): DockState {
  if (dock.mission === null || dock.mission.finishedAt !== null || !isFinished(dock.cards)) return dock
  return { ...dock, mission: { ...dock.mission, finishedAt: now } }
}

/** Which card a helper's report belongs to: its own agent id, else its task name, else the oldest unlinked working card. */
export function findHelper(dock: DockState, agentId: string, task: string): DockCard | undefined {
  const own = dock.cards.find(card => card.agentId === agentId)
  if (own) return own
  const name = taskName(task).toLowerCase()
  const unlinked = dock.cards.filter(card => card.agentId === null && card.status !== 'done' && card.status !== 'stuck')
  return unlinked.find(card => card.name.toLowerCase() === name) ?? unlinked.find(card => card.status === 'working')
}

export function progressHelper(dock: DockState, agentId: string, task: string, percent: number, now: number): DockState {
  const card = findHelper(dock, agentId, task)
  if (!card) return dock
  const value = clampPercent(percent)
  const next = patch(dock, one => one.id === card.id, one => ({
    ...one,
    agentId,
    status: one.status === 'queued' ? 'working' : one.status,
    startedAt: one.startedAt ?? now,
    percent: one.status === 'done' ? 100 : value,
    hasReported: true,
  }))
  return next
}

export function workingCount(dock: DockState): number {
  return dock.cards.filter(card => card.status === 'working').length
}

// --- Faces ----------------------------------------------------------------------

export const HEADSHOT_DIR = 'employee-headshots'
export const HEADSHOTS = ['kwilkins9', 'maya', 'theo', 'sam'] as const

export type TerminalEnv = {
  term?: string
  termProgram?: string
  kittyWindowId?: string
  ghosttyResourcesDir?: string
  tmux?: string
}

/** Whether the terminal draws pictures (the kitty graphics protocol); tmux passes none through. */
export function canDrawImages(env: TerminalEnv): boolean {
  if (env.tmux) return false
  if (env.kittyWindowId || env.ghosttyResourcesDir) return true
  const term = (env.term ?? '').toLowerCase()
  const program = (env.termProgram ?? '').toLowerCase()
  return term.includes('kitty') || term.includes('ghostty') || ['ghostty', 'wezterm', 'iterm.app', 'foot'].includes(program)
}

/** The headshot for the card at `index`, cycling through the faces that exist. */
export function faceFor(index: number, faces: readonly string[]): string | null {
  if (faces.length === 0) return null
  return faces[((index % faces.length) + faces.length) % faces.length] ?? null
}
