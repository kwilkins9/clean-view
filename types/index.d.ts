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

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist
      tick: number
    }
  }
}
