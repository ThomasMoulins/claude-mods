import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'
const P = `${ROOT}/MonJeu`
// The layout of a Unity project with Wwise: WwiseSettings.xml points outside Assets/.
const SETTINGS = `<?xml version='1.0'?>
<WwiseSettings>
    <WwiseStreamingAssetsPath>Audio/GeneratedSoundBanks</WwiseStreamingAssetsPath>
    <RootOutputPath>../MonJeu_WwiseProject/GeneratedSoundBanks/</RootOutputPath>
    <WwiseProjectPath>../MonJeu_WwiseProject/MonJeu_WwiseProject.wproj</WwiseProjectPath>
</WwiseSettings>`

const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

type Entry = { name: string; kind: 'file' | 'dir'; mtimeMs?: number }

function engine(on: On, world: { hasWwise?: boolean; bankTime?: number | null; sourceTime?: number } = {}) {
  const statuses: (string | undefined)[] = []
  const tree: Record<string, Entry[]> = {
    [ROOT]: [{ name: 'MonJeu', kind: 'dir' }],
    [`${P}/Assets`]: [{ name: 'Scripts', kind: 'dir' }],
    [`${P}/MonJeu_WwiseProject`]: [
      { name: 'MonJeu_WwiseProject.wproj', kind: 'file', mtimeMs: 1_000 },
      { name: 'Events', kind: 'dir' },
      { name: 'GeneratedSoundBanks', kind: 'dir' },
      { name: 'Originals', kind: 'dir' },
    ],
    [`${P}/MonJeu_WwiseProject/Events`]: [{ name: 'Default Work Unit.wwu', kind: 'file', mtimeMs: world.sourceTime ?? 2_000 }],
    [`${P}/MonJeu_WwiseProject/Originals`]: [{ name: 'new.wav.wwu', kind: 'file', mtimeMs: 9_999_999 }],
    [`${P}/MonJeu_WwiseProject/GeneratedSoundBanks`]: [
      { name: 'ProjectInfo.json', kind: 'file', mtimeMs: 500 },
      ...(world.bankTime === null ? [] : [{ name: 'Mac', kind: 'dir' as const }]),
    ],
    [`${P}/MonJeu_WwiseProject/GeneratedSoundBanks/Mac`]: [
      { name: 'Init.bnk', kind: 'file', mtimeMs: world.bankTime ?? 100_000 },
      { name: 'Main.bnk', kind: 'file', mtimeMs: world.bankTime ?? 100_000 },
    ],
  }
  mock.clock(on)
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', (_, e) => ({
    value: e.path === `${P}/ProjectSettings/ProjectVersion.txt` || (e.path === `${P}/Assets/WwiseSettings.xml` && world.hasWwise !== false),
  }))
  on('fs.read', (_, e) => (e.path === `${P}/Assets/WwiseSettings.xml` ? { value: SETTINGS } : { deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.list', (_, e) => {
    const entries = tree[e.path]
    return entries ? { value: entries.map(x => ({ size: 1, isLink: false, mtimeMs: 0, ...x })) } : { deny: 'ENOENT' }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { statuses }
}

test('banks newer than the Wwise sources are up to date', async ($, on) => {
  const { statuses } = engine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ ...RUN, command: 'wwise' })
  expect(r).toMatchObject({ text: '✓ 2 SoundBanks à jour dans MonJeu/MonJeu_WwiseProject/GeneratedSoundBanks.' })
  expect(statuses.at(-1)).toBeUndefined()
})

test('no bank at all says the game will be silent and how to generate them', async ($, on) => {
  const { statuses } = engine(on, { bankTime: null })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ ...RUN, command: 'wwise' })
  expect(r).toMatchObject({ text: expect.stringContaining('Aucune SoundBank (.bnk) dans MonJeu/MonJeu_WwiseProject/GeneratedSoundBanks') })
  expect(r).toMatchObject({ text: expect.stringContaining('MonJeu/MonJeu_WwiseProject/MonJeu_WwiseProject.wproj dans Wwise Authoring, puis Project > Generate SoundBanks') })
  expect(statuses.at(-1)).toBe('🔇 SoundBanks Wwise absentes : le jeu sera muet · /wwise')
})

test('a work unit edited after the banks makes them stale; Originals/ does not count', async ($, on) => {
  const { statuses } = engine(on, { bankTime: 100_000, sourceTime: 500_000 })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ ...RUN, command: 'wwise' })
  expect(r).toMatchObject({ text: expect.stringContaining('modifié après la dernière génération des 2 SoundBanks') })
  expect(statuses.at(-1)).toBe('SoundBanks Wwise plus anciennes que le projet Wwise · /wwise')
})

test('a project without Wwise stays silent', async ($, on) => {
  const { statuses } = engine(on, { hasWwise: false })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ ...RUN, command: 'wwise' })
  expect(r).toMatchObject({ text: expect.stringContaining('Pas de projet Wwise ici') })
  expect(statuses.every(s => s === undefined)).toBe(true)
})

test('/claude-mods lists the commands of the claude-mods plugins only', async ($, on) => {
  engine(on)
  const info = (name: string, plugin: string | undefined) => ({ name, description: `d-${name}`, source: 'plugin', plugin })
  on('command.list', () => ({
    value: [info('wwise', 'wwise-soundbank-check@inline'), info('unity-test', 'unity-test-runner@claude-mods'), info('board', 'project-board'), info('other', 'someone-else'), info('help', undefined)] as never,
  }))
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = (await $.command.run({ ...RUN, command: 'claude-mods' })) as { text: string }
  expect(r.text).toContain('**unity-test-runner**\n- /unity-test : d-unity-test')
  expect(r.text).toContain('**wwise-soundbank-check**\n- /wwise : d-wwise')
  expect(r.text).not.toContain('/other')
  expect(r.text).toContain('Sans commande ou pas installés ici : unity-console, unity-asset-guard, unity-ci-status, unity-log-digest.')
})
