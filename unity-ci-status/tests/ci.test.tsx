import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { latestRuns, statusLine } from '../hooks/runs'

const NOW = Date.parse('2026-10-29T10:00:00Z')
const run = (id: number, workflowName: string, conclusion: string, createdAt: string, status = 'completed') => ({
  databaseId: id,
  workflowName,
  displayTitle: 'feat(player): porter gameplay',
  status,
  conclusion,
  createdAt,
  url: `https://github.com/o/r/actions/runs/${id}`,
})
// gh lists newest first, several runs per workflow.
const RUNS = [
  run(3, 'Branch Protection', 'success', '2026-10-29T09:50:00Z'),
  run(2, 'Unity CI', 'failure', '2026-10-29T09:48:00Z'),
  run(1, 'Unity CI', 'success', '2026-10-28T09:00:00Z'),
]
const JOBS = { jobs: [{ name: 'Run all tests', conclusion: 'failure' }, { name: 'Build player', conclusion: 'skipped' }] }

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const PANE = {
  plugin: 'unity-ci-status',
  component: 'Pane',
  requestId: 'unity-ci-status',
  props: { title: 'CI', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function engine(on: On, world: { runs?: unknown[]; branch?: string; config?: string } = {}) {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const sent: string[] = []
  const argvs: string[][] = []
  const state = { runs: world.runs ?? RUNS }
  const clock = mock.clock(on, { now: NOW })
  const config = '/repo/.claude/claude-mods.json'
  on('session.root', () => ({ value: '/repo' }))
  on('fs.stat', (_, e) => (e.path === config && world.config ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', (_, e) => (e.path === config && world.config ? { value: world.config } : { deny: 'ENOENT' }))
  on('process.run', (_, e) => {
    argvs.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git') return ok(`${world.branch ?? 'porteur'}\n`)
    if (e.argv[2] === 'list') return ok(JSON.stringify(state.runs))
    return ok(JSON.stringify(JOBS))
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { drop: 'test' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { statuses, toasts, sent, argvs, state, clock }
}

test('only the newest run of each workflow counts', () => {
  const runs = latestRuns(JSON.stringify(RUNS), undefined)
  expect(runs.map(r => `${r.workflow}:${r.conclusion}`)).toEqual(['Branch Protection:success', 'Unity CI:failure'])
  expect(latestRuns(JSON.stringify(RUNS), ['Unity CI'])).toHaveLength(1)
  expect(statusLine('chest', [], NOW)).toBe('CI chest : aucun run')
})

test('the status line names the failed workflow and its jobs, and the pane offers an analysis', async ($, on) => {
  const { statuses, sent, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'ci' })
  await clock.settle()

  expect(statuses.at(-1)).toBe('CI porteur : ✗ Unity CI (Run all tests) · /ci')
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Unity CI/ }))?.text).toBe('✗ Unity CI · il y a 12 min')
    expect((await ui.find({ type: 'Text', text: /Jobs en échec/ }))?.text).toBe('Jobs en échec : Run all tests')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'analyse-2' })
  await ui.unmount()
  expect(sent[0]).toContain('gh run view 2 --log-failed')
})

test('a failure already there at start is not toasted; a new one is', async ($, on) => {
  const { toasts, state, clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'ci' })
  await clock.settle()
  expect(toasts).toHaveLength(0)

  state.runs = [run(4, 'Unity CI', 'failure', '2026-10-29T10:01:00Z'), ...RUNS]
  await clock.advance(90_000)
  expect(toasts).toEqual(['CI porteur : Unity CI a échoué'])
})

test('all green, and no run at all', async ($, on) => {
  const { statuses, state, clock } = engine(on, { runs: [run(3, 'Branch Protection', 'success', '2026-10-29T09:00:00Z')] })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'ci' })
  await clock.settle()
  expect(statuses.at(-1)).toBe('CI porteur : ✓ 1 workflow (il y a 1 h)')

  state.runs = []
  await clock.advance(90_000)
  expect(statuses.at(-1)).toBe('CI porteur : aucun run')
})
