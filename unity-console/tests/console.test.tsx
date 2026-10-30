import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { parseEditorLog, repoPath } from '../hooks/parse'
import { absoluteIn, relativeTo, samePath } from '../hooks/project'

const LOG = [
  'Successfully changed project path to: /repo/MonJeu',
  '[ScriptCompilation] Requested script compilation because: Assetdatabase observed changes in script compilation related files',
  "Assets/Scripts/Player/PlayerController.cs(42,13): error CS0103: The name 'speed' does not exist in the current context",
  "Assets/Scripts/Player/PlayerController.cs(42,13): error CS0103: The name 'speed' does not exist in the current context",
  "Assets/Scripts/Data/BalancingData.cs(7,20): error CS0029: Cannot implicitly convert type 'string' to 'int'",
  "Assets/Synty/Foo.cs(1,1): warning CS0618: 'Bar' is obsolete",
  'Scripts have compiler errors.',
].join('\n')

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const PANE = {
  plugin: 'unity-console',
  component: 'Pane',
  requestId: 'unity-console',
  props: {
    title: 'Unity',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type World = {
  root?: string
  env?: Record<string, string>
  logPath?: string
  log?: string
  // Unity projects (absolute) and other folders, as the disk has them.
  projects?: string[]
  dirs?: Record<string, string[]>
  config?: string
}

// On Windows the engine hands the fs mocks C:\repo\... for /repo/...: the fake disk keys by the POSIX path.
const posix = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// Stands for the disk and the engine beneath the mod.
function engine(on: On, world: World = {}) {
  const root = world.root ?? '/repo'
  const logPath = world.logPath ?? '/Users/me/Library/Logs/Unity/Editor.log'
  const log = world.log ?? LOG
  const projects = world.projects ?? [`${root}/MonJeu`]
  // The MON-JEU repo has a stray ProjectSettings/ at its root, beside an empty Assets/.
  const dirs = world.dirs ?? { [root]: ['MonJeu', 'Documentation', '.git'], [`${root}/Assets`]: [] }
  const env = world.env ?? { HOME: '/Users/me' }
  const files: Record<string, string> = { [logPath]: log }
  if (world.config !== undefined) files[`${root}/.claude/claude-mods.json`] = world.config
  const sent: string[] = []
  const written: Record<string, string> = {}

  mock.clock(on)
  on('session.root', () => ({ value: root }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.exists', (_, e) => {
    const path = posix(e.path)
    return {
      value:
        path in files ||
        path === `${root}/ProjectSettings/ProjectVersion.txt` ||
        projects.some(p => path === `${p}/ProjectSettings/ProjectVersion.txt`) ||
        path === '/Users/me/Library/Logs',
    }
  })
  on('fs.list', (_, e) => {
    const path = posix(e.path)
    if (projects.some(p => path === `${p}/Assets`)) return { value: [{ name: 'Scripts', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    const names = dirs[path]
    if (names === undefined) return { deny: 'ENOENT' }
    return { value: names.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_, e) => {
    const text = files[posix(e.path)]
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: text.length, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = files[posix(e.path)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_, e) => {
    written[posix(e.path)] = e.text
    files[posix(e.path)] = e.text
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { drop: 'test' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { root, sent, written }
}

test('the parser keeps the last compilation, without duplicates', () => {
  const fixed = `${LOG}\n[ScriptCompilation] Requested script compilation because: changed\nAssetDatabase: script compilation time: 2.1s`
  expect(parseEditorLog(LOG).errors).toHaveLength(2)
  expect(parseEditorLog(LOG).warningCount).toBe(1)
  expect(parseEditorLog(LOG).project).toBe('/repo/MonJeu')
  expect(parseEditorLog(fixed).state).toBe('ok')
  expect(parseEditorLog(fixed).errors).toHaveLength(0)
  expect(parseEditorLog('[ScriptCompilation] Requested script compilation because: x').state).toBe('compiling')
})

test('the pane lists each error with its file and line, and sends only them to Claude', async ($, on) => {
  const { sent } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'unity-errors' })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /erreurs de compilation/ }))?.text).toContain('2 erreurs')
    // The stray project at the root is skipped: MonJeu/ is found.
    expect((await ui.find({ type: 'Text', text: /détecté/ }))?.text).toBe('Projet Unity : MonJeu (détecté automatiquement).')
    expect(await ui.find({ type: 'Text', text: /MonJeu\/Assets\/Scripts\/Player\/PlayerController\.cs:42 · CS0103/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /CS0103/ })).toHaveLength(1)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'send' })
  await ui.unmount()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('MonJeu/Assets/Scripts/Data/BalancingData.cs:7:20 CS0029')
  expect(sent[0]).not.toContain('CS0618')
})

test('Windows paths: backslashes and drive letters compare without case', () => {
  expect(samePath('C:/Users/Me/Game/MonJeu', 'c:\\users\\me\\game\\MonJeu')).toBe(true)
  expect(samePath('/Users/Me/MonJeu', '/users/me/drush')).toBe(false)
  expect(relativeTo('C:\\Users\\me\\Game', 'C:\\Users\\me\\Game\\MonJeu\\Assets\\A.cs')).toBe('MonJeu/Assets/A.cs')
  expect(absoluteIn('C:\\Users\\me\\Game', 'MonJeu')).toBe('C:/Users/me/Game/MonJeu')
  expect(absoluteIn('C:\\Users\\me\\Game', 'D:\\Other')).toBe('D:/Other')
  expect(repoPath('Assets\\Scripts\\A.cs', 'MonJeu')).toBe('MonJeu/Assets/Scripts/A.cs')
})

test('with LOCALAPPDATA set (Windows), the log is read under it', async ($, on) => {
  engine(on, { env: { LOCALAPPDATA: '/win/AppData/Local', HOME: '' }, logPath: '/win/AppData/Local/Unity/Editor/Editor.log' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'unity-errors' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /erreurs de compilation/ }))?.text).toContain('2 erreurs')
  await ui.unmount()
})

test('/unity-project sets the folder in .claude/claude-mods.json, and refuses a folder that is no project', async ($, on) => {
  const { written } = engine(on, {
    projects: ['/repo/MonJeu', '/repo/Prototype'],
    dirs: { '/repo': ['MonJeu', 'Prototype'], '/repo/Assets': [] },
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  // Two projects: the pane asks which one.
  await $.command.run({ ...RUN, command: 'unity-errors' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Plusieurs projets/ }))?.text).toContain('MonJeu, Prototype')
  await ui.unmount()

  const refused = await $.command.run({ ...RUN, command: 'unity-project', args: 'Documentation' })
  expect(refused).toMatchObject({ text: expect.stringContaining("n'est pas un projet Unity") })

  const set = await $.command.run({ ...RUN, command: 'unity-project', args: 'MonJeu' })
  expect(set).toMatchObject({ text: expect.stringContaining('réglé sur MonJeu') })
  expect(JSON.parse(written['/repo/.claude/claude-mods.json'] ?? '{}')).toEqual({ unityProject: 'MonJeu' })

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /erreurs de compilation/ }))?.text).toContain('2 erreurs')
  await ui.unmount()
})

test('a log of another project shows no errors', async ($, on) => {
  engine(on, { log: LOG.replace('/repo/MonJeu', '/elsewhere/Game') })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run({ ...RUN, command: 'unity-errors' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /autre projet/ }))?.text).toContain('/elsewhere/Game')
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.unmount()
})
