import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { parseNUnit } from '../hooks/nunit'
import { parseArgs } from '../hooks/register'

const ROOT = '/repo'
const REPORT = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Failed(Child)" total="3" passed="2" failed="1" inconclusive="0" skipped="0" asserts="0" engine-version="3.5.0.0" clr-version="4.0.30319.42000" start-time="2026-10-29 10:00:00Z" end-time="2026-10-29 10:00:03Z" duration="3.214">
  <test-suite type="TestSuite" name="MonJeu" result="Failed">
    <test-case id="1001" name="Jump_WhenGrounded" fullname="MonJeu.Tests.Editor.PlayerTests.Jump_WhenGrounded" result="Passed" duration="0.01" />
    <test-case id="1002" name="Speed_IsClamped" fullname="MonJeu.Tests.Editor.PlayerTests.Speed_IsClamped" result="Failed" duration="0.02">
      <failure>
        <message><![CDATA[  Expected: 10
  But was:  12
]]></message>
        <stack-trace><![CDATA[at MonJeu.Tests.Editor.PlayerTests.Speed_IsClamped () [0x00012] in /repo/MonJeu/Assets/Tests/Editor/PlayerTests.cs:42
]]></stack-trace>
      </failure>
    </test-case>
    <test-case id="1003" name="Loot_IsEmpty" fullname="MonJeu.Tests.Editor.LootTests.Loot_IsEmpty" result="Passed" duration="0.01" />
  </test-suite>
</test-run>`

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const PANE = {
  plugin: 'unity-test-runner',
  component: 'Pane',
  requestId: 'unity-test-runner',
  props: { title: 'Tests Unity', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type World = { editorOpen?: boolean; exitCode?: number; writesReport?: boolean; noCli?: boolean }

// On Windows the engine hands the fs mocks C:\repo\... for /repo/...: the fake disk keys by the POSIX path.
const posix = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

function engine(on: On, world: World = {}) {
  const spawned: string[][] = []
  const sent: string[] = []
  const files: Record<string, string> = {}
  const clock = mock.clock(on, { now: 1_000 })
  on('session.root', () => ({ value: ROOT }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('fs.exists', (_, e) => {
    const path = posix(e.path)
    return {
      value:
        path === `${ROOT}/MonJeu/ProjectSettings/ProjectVersion.txt` ||
        (path.endsWith('/Temp/UnityLockfile') && world.editorOpen === true) ||
        path in files,
    }
  })
  on('fs.list', (_, e) => {
    const path = posix(e.path)
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    if (path === ROOT) return { value: [dir('MonJeu')] }
    if (path === `${ROOT}/MonJeu/Assets`) return { value: [dir('Tests')] }
    return { deny: 'ENOENT' }
  })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.read', (_, e) => (posix(e.path) in files ? { value: files[posix(e.path)] ?? '' } : { deny: 'ENOENT' }))
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    if (world.noCli || e.argv[0] !== 'unity') return { deny: 'ENOENT: cannot start' }
    yield { stream: 'stdout' as const, text: 'Running EditMode tests…\n' }
    await clock.sleep(3000)
    const output = e.argv[e.argv.indexOf('--output') + 1]
    if (world.writesReport !== false && output) files[output] = REPORT
    yield { stream: 'stderr' as const, text: world.writesReport === false ? 'error CS0103: compile error\nScripts have compiler errors.\n' : 'done\n' }
    return { value: { code: world.exitCode ?? 8, signal: null } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { drop: 'test' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { spawned, sent, clock }
}

test('arguments pick the mode and the filter', () => {
  expect(parseArgs('')).toEqual({ modes: ['EditMode'], filter: '' })
  expect(parseArgs('play')).toEqual({ modes: ['PlayMode'], filter: '' })
  expect(parseArgs('all Player')).toEqual({ modes: ['EditMode', 'PlayMode'], filter: 'Player' })
  expect(parseArgs('PlayerTests')).toEqual({ modes: ['EditMode'], filter: 'PlayerTests' })
})

test('the NUnit report gives the totals and each failure with its file and line', () => {
  const r = parseNUnit(REPORT)
  expect(r).toMatchObject({ total: 3, passed: 2, failed: 1, skipped: 0, durationS: 3.2 })
  expect(r?.failures[0]).toEqual({
    name: 'MonJeu.Tests.Editor.PlayerTests.Speed_IsClamped',
    message: 'Expected: 10',
    file: '/repo/MonJeu/Assets/Tests/Editor/PlayerTests.cs',
    line: 42,
  })
})

test('/unity-test runs the CLI on the detected project and shows the failures', async ($, on) => {
  const { spawned, sent, clock } = engine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'unity-test', args: 'edit Player' })

  const running = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await running.find({ type: 'Text', text: /en cours/ }))?.text).toContain('EditMode en cours')
  expect(await running.find({ key: 'stop' })).toBeDefined()
  await running.unmount()

  await clock.advance(3000)
  expect(spawned[0]).toEqual(['unity', 'test', '/repo/MonJeu', '--mode', 'EditMode', '--output', '/repo/MonJeu/Logs/claude-tests-EditMode.xml', '--no-banner', '--non-interactive', '--filter', 'Player'])

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /en échec/ }))?.text).toBe('✗ 1 en échec · 2 réussis · 3 s')
    expect((await ui.find({ type: 'Text', text: /Speed_IsClamped/ }))?.text).toContain('MonJeu/Assets/Tests/Editor/PlayerTests.cs:42')
    await ui.unmount()
  }

  const done = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await done.press({ key: 'send' })
  await done.unmount()
  expect(sent[0]).toContain('MonJeu.Tests.Editor.PlayerTests.Speed_IsClamped (MonJeu/Assets/Tests/Editor/PlayerTests.cs:42) : Expected: 10')
})

test('a run without a report says it did not finish, with the last lines', async ($, on) => {
  const { clock } = engine(on, { exitCode: 6, writesReport: false })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'unity-test', args: 'edit' })
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /n'ont pas abouti/ }))?.text).toContain('code 6')
  expect(await ui.find({ type: 'Text', text: /Scripts have compiler errors/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.unmount()
})

test('the Editor holding the project blocks the run', async ($, on) => {
  const { spawned } = engine(on, { editorOpen: true })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ ...RUN, command: 'unity-test', args: 'edit' })
  expect(r).toMatchObject({ text: expect.stringContaining("l’Editor Unity a le projet ouvert") })
  expect(spawned).toHaveLength(0)
})

test('without the CLI, the run says where to set it', async ($, on) => {
  const { clock, spawned } = engine(on, { noCli: true })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'unity-test', args: 'edit' })
  await clock.advance(10)
  expect(spawned.map(a => a[0])).toEqual(['unity', '/Users/me/.unity/bin/unity', '/Users/me/.unity/bin/unity.exe'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /introuvable/ }))?.text).toContain('unityCli')
  await ui.unmount()
})
