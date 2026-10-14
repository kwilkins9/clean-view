// Pure checklist logic: no `$`, so the tests can call it directly.
import type { CleanViewChecklist, CleanViewTask } from '../types'

export const MAX_NAME = 40
export const FALLBACK_NAME = 'Working on it'
export const PLACEHOLDER_STEPS = ['Understand your request', 'Plan the steps']

const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|css|scss|sass|less|html?|json|ya?ml|toml|ini|md|mdx|sh|bash|zsh|sql|vue|svelte|lock|env|xml|gradle|dart|lua|pl|r)$/i

/** Turns any name into plain words: no code, paths or file names, at most 40 characters. */
export function cleanName(raw: string): string {
  const words = String(raw ?? '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
    .split(/\s+/)
    .filter(word => {
      if (word === '') return false
      if (word.includes('/') || word.includes('\\')) return false
      const bare = word.replace(/[)\]},.;:!?'"]+$/, '').replace(/^[(\[{'"]+/, '')
      return !CODE_FILE.test(bare)
    })
  let name = words.join(' ').trim()
  if (name === '') return FALLBACK_NAME
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (name.length <= MAX_NAME) return name

  const room = MAX_NAME - 1
  const cut = name.slice(0, room + 1)
  const space = cut.lastIndexOf(' ')
  const head = (space > 0 ? cut.slice(0, space) : name.slice(0, room)).replace(/[\s,.;:-]+$/, '')
  return `${head}…`
}

/** Short job title from a model reply: 2 to 6 plain words. */
export function cleanTitle(raw: string): string | null {
  const line = String(raw ?? '').split('\n').find(one => one.trim() !== '') ?? ''
  const words = cleanName(line.replace(/["“”*#_.]/g, ' ')).replace(/…$/, '').split(' ').slice(0, 6)
  const title = words.join(' ')
  return words.length < 2 || title === FALLBACK_NAME ? null : title
}

export function clampPercent(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

let seq = 0
export function makeTask(name: string, status: CleanViewTask['status'], id?: string): CleanViewTask {
  seq += 1
  return {
    id: id ?? `step-${Date.now().toString(36)}-${seq}`,
    name: cleanName(name),
    status,
    percent: status === 'done' ? 100 : 0,
    hasReported: status === 'done',
  }
}

export function emptyChecklist(): CleanViewChecklist {
  return {
    title: '',
    phase: 'idle',
    tasks: [],
    needsYouReason: null,
    stuckReason: null,
    startedAt: null,
    finishedAt: null,
    isCollapsed: false,
    jobId: 0,
    hasPlan: false,
    isRunning: false,
  }
}

export function newJob(prev: CleanViewChecklist, now: number): CleanViewChecklist {
  return {
    ...emptyChecklist(),
    title: 'Working on your request',
    phase: 'working',
    tasks: PLACEHOLDER_STEPS.map((name, i) => makeTask(name, i === 0 ? 'active' : 'upcoming')),
    startedAt: now,
    jobId: prev.jobId + 1,
    isRunning: true,
  }
}

/** Exactly one active step: the first that is not done, when no step is active. */
function settle(tasks: CleanViewTask[]): CleanViewTask[] {
  let seenActive = false
  const out = tasks.map(task => {
    if (task.status !== 'active') return task
    if (seenActive) return { ...task, status: 'upcoming' as const }
    seenActive = true
    return task
  })
  if (seenActive) return out
  const first = out.findIndex(task => task.status === 'upcoming')
  return first < 0 ? out : out.map((task, i) => (i === first ? { ...task, status: 'active' as const } : task))
}

export function applyPlan(list: CleanViewChecklist, steps: readonly string[]): CleanViewChecklist {
  const names = steps.map(cleanName).slice(0, 8)
  const tasks = names.map((name, i) => makeTask(name, i === 0 ? 'active' : 'upcoming'))
  return { ...list, tasks, hasPlan: true, isCollapsed: false }
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function applyProgress(list: CleanViewChecklist, rawTask: string, rawPercent: unknown): CleanViewChecklist {
  const name = cleanName(rawTask)
  const percent = clampPercent(rawPercent)
  let tasks = list.hasPlan ? [...list.tasks] : []
  let index = tasks.findIndex(task => sameName(task.name, name))

  if (index < 0) {
    // A new step goes where the work is now: before the active step, or after the last done one.
    const active = tasks.findIndex(task => task.status === 'active')
    const at = active >= 0 ? active : tasks.filter(task => task.status === 'done').length
    tasks.splice(at, 0, makeTask(name, 'upcoming'))
    index = at
  }

  tasks = tasks.map((task, i) => {
    if (i < index) return { ...task, status: 'done', percent: 100, hasReported: true }
    if (i === index) {
      return percent >= 100
        ? { ...task, status: 'done', percent: 100, hasReported: true }
        : { ...task, status: 'active', percent, hasReported: true }
    }
    return task.status === 'active' ? { ...task, status: 'upcoming' } : task
  })

  return { ...list, tasks: settle(tasks), hasPlan: list.hasPlan || tasks.length > 0 }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export function applyTodos(list: CleanViewChecklist, todos: readonly Todo[]): CleanViewChecklist {
  if (todos.length === 0) return list
  const tasks = todos.map((todo, i): CleanViewTask => {
    const name = cleanName(todo.content)
    const old = list.tasks.find(task => sameName(task.name, name))
    const status: CleanViewTask['status'] =
      todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
    const base = old ?? makeTask(name, 'upcoming', `todo-${i}`)
    return status === 'done'
      ? { ...base, name, status, percent: 100, hasReported: true }
      : { ...base, name, status, percent: status === 'active' ? base.percent : 0 }
  })
  return { ...list, tasks: settle(tasks), hasPlan: true, isCollapsed: false }
}

export function applyTaskCreate(list: CleanViewChecklist, subject: string, id: string | undefined): CleanViewChecklist {
  const kept = list.hasPlan ? list.tasks : []
  const tasks = [...kept, makeTask(subject, 'upcoming', id ? `task-${id}` : undefined)]
  return { ...list, tasks: settle(tasks), hasPlan: true, isCollapsed: false }
}

export function applyTaskUpdate(
  list: CleanViewChecklist,
  id: string,
  status: string | undefined,
  subject: string | undefined,
): CleanViewChecklist {
  const key = `task-${id}`
  if (!list.tasks.some(task => task.id === key)) return list
  if (status === 'deleted') return { ...list, tasks: settle(list.tasks.filter(task => task.id !== key)) }
  const tasks = list.tasks.map(task => {
    if (task.id !== key) {
      return status === 'in_progress' && task.status === 'active' ? { ...task, status: 'upcoming' as const } : task
    }
    const name = subject ? cleanName(subject) : task.name
    if (status === 'completed') return { ...task, name, status: 'done' as const, percent: 100, hasReported: true }
    if (status === 'in_progress') return { ...task, name, status: 'active' as const }
    if (status === 'pending') return { ...task, name, status: 'upcoming' as const }
    return { ...task, name }
  })
  return { ...list, tasks: settle(tasks) }
}

export function hasUnfinished(list: CleanViewChecklist): boolean {
  return list.tasks.some(task => task.status !== 'done')
}

export function finishAll(list: CleanViewChecklist, now: number): CleanViewChecklist {
  return {
    ...list,
    phase: 'done',
    tasks: list.tasks.map(task => ({ ...task, status: 'done', percent: 100, hasReported: true })),
    needsYouReason: null,
    stuckReason: null,
    finishedAt: now,
    isRunning: false,
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}

const USAGE_LIMIT = 'you hit your usage limit, try again a little later'
const BUSY = "Claude's servers are busy, try again in a minute"

const API_ERRORS: Record<string, string> = {
  rate_limit: 'you hit your usage limit, try again a little later',
  billing_error: 'you hit your usage limit, try again a little later',
  overloaded: "Claude's servers are busy, try again in a minute",
  server_error: "Claude's servers are busy, try again in a minute",
  authentication_failed: "you're signed out, type /login",
  oauth_org_not_allowed: "you're signed out, type /login",
  cloud_credential_error: "you're signed out, type /login",
}

/** One calm sentence for an API error kind and its details. */
export function apiErrorSentence(kind: string | null, details: string | null): string {
  const text = `${kind ?? ''} ${details ?? ''}`.toLowerCase()
  if (/too long|context|max_output_tokens|prompt is too/.test(text)) {
    return 'the conversation got too long, type /compact and try again'
  }
  const known = kind === null ? undefined : API_ERRORS[kind]
  if (known !== undefined) return known
  if (/network|connect|socket|fetch failed|timed? ?out|offline|enotfound|eai_again/.test(text)) {
    return 'the internet connection dropped'
  }
  if (/auth|login|401|403/.test(text)) return "you're signed out, type /login"
  if (/rate|429|limit/.test(text)) return USAGE_LIMIT
  if (/overload|529|busy/.test(text)) return BUSY
  return kind === null ? 'the internet connection dropped' : 'something went wrong talking to Claude, try again'
}
