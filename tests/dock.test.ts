import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import {
  canDrawImages,
  emptyDock,
  faceFor,
  instructionText,
  isAcknowledgement,
  meterSegments,
  parseSize,
  progressHelper,
  queueCard,
  restoreSize,
  startCard,
} from '../hooks/dock-logic'

const PANE = 'agent-dock'
const SURFACES = ['terminal', 'desktop'] as const
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
const PANE_PROPS = {
  title: 'Agent Dock',
  isFocused: false,
  bodyColumns: 84,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

type World = { contexts: string[][]; nudges: string[]; panes: Set<string>; statuses: string[]; clock: ReturnType<typeof mock.clock> }

/** The world beneath the plugin: clock, store, prompts, panes, Clean View's turn hooks and the Agent tool. */
function world(on: On, store: Record<string, unknown> = {}): World {
  const w: World = { contexts: [], nudges: [], panes: new Set(), statuses: [], clock: mock.clock(on, { now: 1_000_000 }) }
  mock.store(on, store)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind === 'plugin') w.nudges.push(e.text)
    else w.contexts.push([...(e.context ?? [])])
    return { text: e.text, context: e.context }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    w.statuses.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.open', ($, e) => {
    w.panes.add(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    w.panes.delete(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({
    value: [...w.panes].map(id => ({ id, title: 'Agent Dock', isShown: true, isFocused: false, isPlaced: true })),
  }) as never)
  on('ui.toast', () => ({}) as never)
  let n = 0
  on('tool.call', () => {
    n += 1
    return { result: { agentId: `agent-${n}`, status: 'async_launched' } as never }
  })
  return w
}

async function dock($: Engine, args: string) {
  return $.command.run({ command: 'dock', args, ...COMMAND })
}

async function ask($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
}

async function agent($: Engine, description: string) {
  return $.tool.call({ tool: 'Agent', description, prompt: `Do: ${description}` })
}

async function paneText($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ plugin: 'clean-view', surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text ?? '')
  await ui.unmount()
  return texts.join('\n')
}

const append = (ids: Array<[string, string]>) => ({
  door: 'response' as const,
  uuid: 'row-1',
  origin: { kind: 'model' as const, model: 'test' },
  message: {
    type: 'assistant',
    role: 'assistant',
    content: ids.map(([id, description]) => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'x' } })),
  },
})

describe('team size', () => {
  test('1. parseSize takes whole numbers from 1 to 100', () => {
    expect(parseSize('10')).toBe(10)
    expect(parseSize(' 25 ')).toBe(25)
    for (const bad of ['0', '101', 'abc', '2.5', '', '-3']) expect(parseSize(bad)).toBeNull()
  })

  test('2. a saved 50 comes back as 1 in a new session; 10 stays 10', async ($, on) => {
    expect(restoreSize(50)).toBe(1)
    expect(restoreSize(10)).toBe(10)
    world(on, { 'dock.teamSize': 50 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    expect(await paneText($, 'terminal')).toContain('Your team of 1 is standing by')
  })

  test('2b. a saved 10 survives a new session', async ($, on) => {
    world(on, { 'dock.teamSize': 10 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    expect(await paneText($, 'terminal')).toContain('Your team of 10 is standing by')
  })

  test('3. at size 5 a request carries the exactly-5 instruction; at size 1 nothing', async ($, on) => {
    const w = world(on)
    await ask($, 'Research bakery pricing')
    expect(w.contexts[0]).toEqual([])
    expect((await dock($, '5')).text).toBe('Team Size is now 5.')
    await ask($, 'Research bakery pricing')
    expect(w.contexts[1]).toEqual([instructionText(5)])
    expect(w.contexts[1]?.[0]).toContain('exactly 5 independent pieces')
  })

  test('bad sizes and big teams answer plainly', async ($, on) => {
    const w = world(on)
    expect((await dock($, 'abc')).text).toBe('Team Size is a whole number from 1 to 100, e.g. /dock 10.')
    expect((await dock($, '50')).text).toBe('Confirm the team of 50 in the Agent Dock.')
  })
})

describe('helpers', () => {
  test('4. the 6th Agent call at size 5 is denied', async ($, on) => {
    world(on)
    await dock($, '5')
    await ask($, 'Price check five bakeries')
    for (let i = 1; i <= 5; i += 1) {
      const ran = await agent($, `Price check: store ${i}`)
      expect(ran.deny).toBeUndefined()
    }
    const sixth = await agent($, 'Price check: store 6')
    const refusal = sixth.deny ?? (sixth.isError === true ? sixth.text : '')
    expect(String(refusal)).toBe('Team Size is 5: this request already has 5 helpers. Finish with the helpers you have.')
  })

  test('5. a request that used 3 of 10 gets exactly one nudge', async ($, on) => {
    const w = world(on)
    await dock($, '10')
    await ask($, 'Research ten bakeries')
    for (const name of ['Price check: Panera', 'Price check: Crumbl', 'Price check: Tartine']) await agent($, name)
    const done = { answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' as const }
    await $.turn.complete(done)
    await $.turn.complete({ ...done, turnId: 't2' })
    await w.clock.settle()
    expect(w.nudges).toEqual(['You used 3 of 10 helpers. Split the remaining work across the other 7, one helper per piece, all in parallel.'])
  })

  test('6. three Agent calls go queued, working, done; a report of 60 shows 60%', async ($, on) => {
    world(on)
    await ask($, 'Research bakery pricing')
    await $.session.append(append([['tu1', 'Price check: Panera'], ['tu2', 'Price check: Crumbl'], ['tu3', 'Price check: Tartine']]) as never)
    for (const surface of SURFACES) {
      const text = await paneText($, surface)
      expect(text).toContain('○ 3 queued')
      expect(text).toContain('Price check: Panera')
    }

    await agent($, 'Price check: Panera')
    await agent($, 'Price check: Crumbl')
    await agent($, 'Price check: Tartine')
    for (const surface of SURFACES) expect(await paneText($, surface)).toContain('● 3 working')

    const base = { answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' as const }
    for (const n of [1, 2, 3]) await $.turn.complete({ ...base, turnId: `h${n}`, agentId: `agent-${n}` })
    for (const surface of SURFACES) expect(await paneText($, surface)).toContain('✓ 3 done')

    // A helper's own report_progress runs in its loop, which a test cannot raise; the logic behind it is checked here.
    let d = queueCard(emptyDock(), 'tu1', 'Price check: Panera', 0)
    d = startCard(d, 'tu1', 0)
    d = progressHelper(d, 'agent-1', 'Price check: Panera', 60, 1000)
    expect(d.cards[0]?.percent).toBe(60)
    expect(meterSegments(d.cards[0]!, 10, 0).map(s => s.text).join('')).toBe('━━━━━━────')
  })

  test('7. all done shows "3 agents finished <job> in …"', async ($, on) => {
    world(on)
    await ask($, 'Research bakery pricing, then compare')
    for (const name of ['Price check: Panera', 'Price check: Crumbl', 'Price check: Tartine']) await agent($, name)
    const base = { answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' as const }
    for (const n of [1, 2, 3]) await $.turn.complete({ ...base, turnId: `h${n}`, agentId: `agent-${n}` })
    for (const surface of SURFACES) {
      const text = await paneText($, surface)
      expect(text).toMatch(/3 agents finished Research bakery pricing in \d/)
      expect(text).toContain('C O M P L E T E')
    }
  })

  test('8. /dock folds the pane to the badge and back', async ($, on) => {
    const w = world(on)
    await dock($, '')
    await w.clock.settle()
    expect(w.panes.has(PANE)).toBe(true)
    await dock($, '')
    await w.clock.settle()
    expect(w.panes.has(PANE)).toBe(false)
    expect(w.statuses.some(text => text.startsWith('◆'))).toBe(true)
    await dock($, '')
    await w.clock.settle()
    expect(w.panes.has(PANE)).toBe(true)
  })
})

describe('faces', () => {
  test('the dock knows which terminals draw pictures', () => {
    expect(canDrawImages({ kittyWindowId: '1' })).toBe(true)
    expect(canDrawImages({ term: 'xterm-ghostty' })).toBe(true)
    expect(canDrawImages({ termProgram: 'WezTerm' })).toBe(true)
    expect(canDrawImages({ term: 'xterm-256color' })).toBe(false)
    expect(canDrawImages({ kittyWindowId: '1', tmux: '/tmp/tmux' })).toBe(false)
  })

  test('faces cycle through the headshots', () => {
    const files = ['maya.png', 'theo.png', 'sam.png']
    expect([0, 1, 2, 3, 4].map(i => faceFor(i, files))).toEqual(['maya.png', 'theo.png', 'sam.png', 'maya.png', 'theo.png'])
    expect(faceFor(0, [])).toBeNull()
  })

  test('cards show headshots in a picture terminal and badges on the desktop', async ($, on) => {
    world(on)
    mock.env(on, { KITTY_WINDOW_ID: '1', HOME: '/tmp' })
    on('fs.exists', () => ({ value: true }) as never)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    await ask($, 'Research bakery pricing')
    for (const name of ['Price check: Panera', 'Price check: Crumbl', 'Price check: Tartine']) await agent($, name)

    const term = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    const images = await term.findAll({ type: 'Image' })
    expect(images).toHaveLength(3)
    const sources = JSON.stringify(images.map(one => one.props))
    expect(sources).toContain('employee-headshots/kwilkins9.png')
    expect(sources).toContain('employee-headshots/maya.png')
    await term.unmount()

    const desk = await $.ui.mount({ plugin: 'clean-view', surface: 'desktop', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await desk.findAll({ type: 'Image' })).toHaveLength(0)
    expect((await desk.findAll({ type: 'Text', text: 'PP' })).length).toBeGreaterThan(0)
    await desk.unmount()
  })
})

describe('quiet replies', () => {
  test('short replies like "ok cool" carry no split instruction', async ($, on) => {
    expect(isAcknowledgement('ok cool')).toBe(true)
    expect(isAcknowledgement('Thanks!')).toBe(true)
    expect(isAcknowledgement('sounds good, thank you')).toBe(true)
    expect(isAcknowledgement('fix it')).toBe(false)
    expect(isAcknowledgement('Research bakery pricing')).toBe(false)
    const w = world(on)
    await dock($, '4')
    await ask($, 'ok cool')
    expect(w.contexts[0]).toEqual([])
    await ask($, 'Research four bakeries')
    expect(w.contexts[1]).toEqual([instructionText(4)])
  })

  test('a request that used no helpers gets no follow-up', async ($, on) => {
    const w = world(on)
    await dock($, '4')
    await ask($, 'What is the capital of France?')
    await $.turn.complete({ answer: 'Paris', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.settle()
    expect(w.nudges).toEqual([])
  })
})
