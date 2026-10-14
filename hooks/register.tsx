import type { Register } from 'claude-code'

import { registerCleanView } from './clean-view'
import { registerDock } from './dock'

// Each mod registers its hooks here. The dock goes first, so its hooks for
// helpers' report_progress calls run before Clean View's.
export const register: Register = on => {
  registerDock(on)
  registerCleanView(on)
}
