import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { parseProjectRef } from '../hooks/board'

const ME = 'moi-sur-github'
const CONFIG = '/repo/.claude/claude-mods.json'
const ITEMS = JSON.stringify({
  items: [
    {
      id: 'A',
      title: '[FEAT_INV] Inventaire du joueur',
      status: 'Todo',
      priority: 'High',
      epic: 'Feat : Joueur',
      assignees: [ME],
      'story Points': 8,
      content: { number: 221, url: 'https://github.com/o/r/issues/221', body: 'User Story : en tant que joueur…' },
    },
    { id: 'B', title: 'Coffre', status: 'Review', priority: 'Medium', assignees: [ME], content: { number: 230, url: 'https://github.com/o/r/issues/230', body: '' } },
    { id: 'C', title: 'Ancienne carte', status: 'Done', assignees: [ME], content: { number: 12 } },
    { id: 'D', title: "La carte d'un autre", status: 'Todo', assignees: ['un-autre-membre'], content: { number: 99 } },
  ],
})

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const PANE = {
  plugin: 'project-board',
  component: 'Pane',
  requestId: 'project-board',
  props: {
    title: 'Projet GitHub',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function engine(on: On, world: { config?: string; ghFails?: boolean } = {}) {
  const argvs: string[][] = []
  const sent: string[] = []
  const files: Record<string, string> = {}
  if (world.config !== undefined) files[CONFIG] = world.config
  mock.clock(on, { now: Date.UTC(2026, 9, 29, 9, 30) })
  on('session.root', () => ({ value: '/repo' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.stat', (_, e) => (e.path in files ? { value: { kind: 'file', size: 1, mtimeMs: (files[e.path] ?? '').length, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    argvs.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'gh' && world.ghFails) {
      return { value: { exitCode: 1, stdout: '', stderr: 'error: your authentication token is missing required scopes [read:project]', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === 'api') return ok(`${ME}\n`)
    if (e.argv[2] === 'view') return ok(JSON.stringify({ title: 'MON-JEU' }))
    if (e.argv[2] === 'item-list') return ok(ITEMS)
    return ok('feat/221-inventaire\n')
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { drop: 'test' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { argvs, sent, files }
}

const CONFIGURED = JSON.stringify({ github: { owner: 'mon-orga', number: 359 } })

test('project links are read in every form', () => {
  expect(parseProjectRef('https://github.com/orgs/mon-orga/projects/359')).toEqual({ owner: 'mon-orga', number: 359 })
  expect(parseProjectRef('https://github.com/users/moi-sur-github/projects/2/views/1')).toEqual({ owner: 'moi-sur-github', number: 2 })
  expect(parseProjectRef('mon-orga/359')).toEqual({ owner: 'mon-orga', number: 359 })
  expect(parseProjectRef('MON-JEU')).toBeNull()
})

test('the pane shows only my open cards, by status, with the branch card marked', async ($, on) => {
  const { argvs } = engine(on, { config: CONFIGURED })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'board' })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^MON-JEU/ }))?.text).toBe(`MON-JEU · ${ME}`)
    expect(await ui.find({ type: 'Text', text: /^Todo \(1\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Review \(1\)$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /#221/ }))?.text).toContain('▶ #221')
    expect(await ui.find({ type: 'Text', text: /La carte d'un autre/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Ancienne carte/ })).toBeUndefined()
    await ui.unmount()
  }
  // Read-only: gh is only ever asked to read.
  expect(argvs.filter(a => a[0] === 'gh').every(a => a[1] === 'api' || a[2] === 'item-list' || a[2] === 'view')).toBe(true)
  expect(argvs.find(a => a[2] === 'item-list')).toContain('mon-orga')
})

test('with no project set, the pane says how to set one, and /board-project sets it', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'board' })

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Aucun projet GitHub réglé/ })).toBeDefined()
  await ui.unmount()

  const bad = await $.command.run({ ...RUN, command: 'board-project', args: 'MON-JEU' })
  expect(bad).toMatchObject({ text: expect.stringContaining("n'est pas un projet GitHub") })
  const set = await $.command.run({ ...RUN, command: 'board-project', args: 'https://github.com/orgs/mon-orga/projects/359' })
  expect(set).toMatchObject({ text: expect.stringContaining('mon-orga/359') })
  expect(JSON.parse(files[CONFIG] ?? '{}')).toEqual({ github: { owner: 'mon-orga', number: 359 } })

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Todo \(1\)$/ })).toBeDefined()
  await ui.unmount()
})

test('"Travailler dessus" sends the card to Claude', async ($, on) => {
  const { sent } = engine(on, { config: CONFIGURED })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'board' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'work-A' })
  await ui.unmount()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('carte MON-JEU #221 « [FEAT_INV] Inventaire du joueur »')
  expect(sent[0]).toContain('https://github.com/o/r/issues/221')
})

test('a gh failure is shown with its reason', async ($, on) => {
  engine(on, { config: CONFIGURED, ghFails: true })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'board' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /gh api user/ }))?.text).toContain('read:project')
  await ui.unmount()
})
