import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { cleanName } from '../hooks/checklist'

const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

/** The world beneath the plugin: clock, store, Haiku, turns and every other tool. */
function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on(
    'model.complete',
    () =>
      ({
        isAnswered: true,
        text: 'Build my landing page',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }) as never,
  )
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} as never }))
}

async function startJob($: Engine) {
  await $.turn.start({ text: 'Please build my landing page', turnId: 't1' })
}

async function bandTexts($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: BAND_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text ?? '')
  const buttons = (await ui.findAll({ type: 'Button' })).map(one => one.text ?? '')
  await ui.unmount()
  return { texts, buttons, all: texts.join('\n') }
}

describe('names', () => {
  test('1. names are cleaned into plain words', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
    expect(cleanName('fix the header in src/components/Header.tsx today')).toBe('Fix the header in today')
    expect(cleanName('Update Pricing.tsx styles')).toBe('Update styles')
    const long = cleanName('Write a really long description of every single thing that happens on the page now')
    expect(long.length <= 40).toBe(true)
    expect(long.endsWith('…')).toBe(true)
    expect(cleanName('`npm run build`')).toBe('Working on it')
  })
})

describe('checklist', () => {
  test('2. a to-do list and a 60% report draw ✓ / ▶ 60% / Next / Up next', async ($, on) => {
    world(on)
    await startJob($)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
        { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
        { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
        { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
      ],
    })
    await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 60 } as never)

    for (const surface of SURFACES) {
      const { all, buttons } = await bandTexts($, surface)
      expect(all).toContain('✓')
      expect(all).toContain('Done')
      expect(all).toContain('▶')
      expect(all).toContain('60%')
      expect(all).toContain('██████░░░░')
      expect(all).toContain('Next')
      expect(all).toContain('Up next')
      expect(all).toContain('Build the pricing section')
      expect(buttons.join(' ')).toContain('Clean View: ON')
    }
  })

  test('3. a permission prompt shows Needs you', async ($, on) => {
    world(on)
    on('classic.Notification', () => ({}))
    await startJob($)
    await $.classic.Notification({
      message: 'Claude needs your permission to use Bash',
      notification_type: 'permission_prompt',
    })
    for (const surface of SURFACES) {
      const { all } = await bandTexts($, surface)
      expect(all).toContain('Needs you')
      expect(all).toContain('Claude needs your OK to continue')
      expect(all).toContain('‖')
    }
  })

  test('4. /simple off hides the band, leaving only the button', async ($, on) => {
    world(on)
    await startJob($)
    const ran = await $.command.run({ command: 'simple', args: 'off', ...COMMAND })
    expect(ran.text).toBe('Clean View is off.')
    for (const surface of SURFACES) {
      const { all, buttons } = await bandTexts($, surface)
      expect(all).not.toContain('Understand your request')
      expect(all).not.toContain('Working on your request')
      expect(buttons.join(' ')).toContain('Clean View: OFF')
    }
    const back = await $.command.run({ command: 'simple', args: '', ...COMMAND })
    expect(back.text).toBe('Clean View is on.')
  })

  test('5. plan_steps then report_progress 100 checks off step one and starts step two', async ($, on) => {
    world(on)
    await startJob($)
    const planned = await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page', 'Check it'] } as never)
    expect(planned.result).toBe('Planned 3 steps. The first one has started.')
    const noted = await $.tool.call({ tool: PROGRESS, task: 'Read your notes', percent: 100 } as never)
    expect(noted.result).toBe('Progress noted: 100%.')
    for (const surface of SURFACES) {
      const { texts } = await bandTexts($, surface)
      const row = (name: string) => texts.slice(texts.findIndex(text => text.startsWith(name)))
      expect(row('Read your notes')).toEqual(expect.arrayContaining(['██████████']))
      expect(texts[texts.findIndex(text => text.startsWith('Read your notes')) + 3]).toContain('Done')
      expect(texts[texts.findIndex(text => text.startsWith('Build the page')) - 2]).toBe('▶')
      expect(texts[texts.findIndex(text => text.startsWith('Build the page')) + 3]).toContain('Working')
      expect(texts[texts.findIndex(text => text.startsWith('Check it')) + 3]).toContain('Next')
    }
  })

  test('6. tools are denied before a plan exists and allowed after', async ($, on) => {
    world(on)
    await startJob($)
    const before = await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.txt' })
    const refusal = before.deny ?? (before.isError === true ? before.text : undefined)
    expect(String(refusal)).toContain('plan_steps')
    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Write the summary'] } as never)
    const after = await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.txt' })
    expect(after.deny).toBeUndefined()
    expect(after.isError).toBeUndefined()
  })
})

describe('hidden rows', () => {
  test('tool rows draw as hidden while Clean View is on', async ($, on) => {
    world(on)
    const props = { tool_use_id: 'tu1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false }
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'clean-view', surface, component: 'ToolUse', props })
      expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })
      await ui.unmount()
    }
  })
})
