export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
}

export type CleanViewPhase =
  | 'idle'
  | 'working'
  | 'needsYou'
  | 'stuck'
  | 'stopped'
  | 'done'

export type CleanViewChecklist = {
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number | null
  finishedAt: number | null
  isCollapsed: boolean
  /** Bumped for every new job, so late answers for an older job are ignored. */
  jobId: number
  /** True once a real plan (plan_steps, TodoWrite or TaskCreate) exists. */
  hasPlan: boolean
  /** True while a main-loop turn is running. */
  isRunning: boolean
}

export type DockCardStatus = 'queued' | 'working' | 'done' | 'stuck'

/** One helper agent's card in the Agent Dock. */
export type DockCard = {
  /** The tool_use_id of the Agent call that launched it. */
  id: string
  /** The helper's agent id, once known. */
  agentId: string | null
  name: string
  status: DockCardStatus
  percent: number
  hasReported: boolean
  startedAt: number | null
  finishedAt: number | null
}

export type DockMission = {
  id: string
  title: string
  startedAt: number
  finishedAt: number | null
  /** Agent calls the main loop made for this request. */
  agentCalls: number
  /** True once the "you used X of N" follow-up was sent. */
  hasNudged: boolean
}

export type DockState = {
  teamSize: number
  /** A big team waiting for Continue or Cancel. */
  pendingSize: number | null
  isCustomOpen: boolean
  helperModel: 'fast' | 'same'
  mission: DockMission | null
  cards: DockCard[]
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist
      tick: number
      dock: DockState
      dockTick: number
    }
  }
}
