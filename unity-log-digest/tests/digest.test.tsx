import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { digestOutput, isUnityOutputCommand, reportPathOf } from '../hooks/digest'

const ROOT = '/repo'
const NOISE = Array.from({ length: 4000 }, (_, i) => `[ ${i}/4000 ] Start importing Assets/Thing${i}.png using Guid(abc) (TextureImporter)`)
const LONG = [
  ...NOISE.slice(0, 2000),
  "Assets/Scripts/Player.cs(42,13): error CS0103: The name 'speed' does not exist in the current context",
  "Assets/Scripts/Player.cs(42,13): error CS0103: The name 'speed' does not exist in the current context",
  "Assets/Synty/Foo.cs(1,1): warning CS0618: 'Bar' is obsolete",
  'Error building Player because scripts have compile errors in the editor',
  ...NOISE.slice(2000),
  'Exiting batchmode with return code 1',
].join('\n')
const REPORT = `<test-run total="3" passed="2" failed="1" inconclusive="0" skipped="0" duration="1.5">
<test-case name="A" fullname="T.A" result="Passed" />
<test-case name="B" fullname="T.B" result="Failed"><failure><message><![CDATA[Expected 1 but was 2]]></message><stack-trace><![CDATA[at T.B () in /repo/MonJeu/Assets/Tests/B.cs:9]]></stack-trace></failure></test-case>
</test-run>`

function engine(on: On, world: { stdout?: string; isError?: boolean; report?: string } = {}) {
  const written: Record<string, string> = {}
  const ran: string[] = []
  mock.clock(on, { now: 50_000 })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', (_, e) => ({ value: e.path === `${ROOT}/MonJeu/ProjectSettings/ProjectVersion.txt` || e.path === `${ROOT}/ProjectSettings/ProjectVersion.txt` }))
  on('fs.list', (_, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    if (e.path === ROOT) return { value: [dir('MonJeu')] }
    if (e.path === `${ROOT}/MonJeu/Assets`) return { value: [dir('Scripts')] }
    if (e.path === `${ROOT}/Assets`) return { value: [] }
    return { deny: 'ENOENT' }
  })
  on('fs.stat', (_, e) => (world.report && e.path.endsWith('.xml') ? { value: { kind: 'file', size: 1, mtimeMs: 50_000, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', (_, e) => (world.report && e.path.endsWith('.xml') ? { value: world.report } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.call', (_, e) => {
    ran.push(e.tool === 'Bash' ? e.command : e.tool)
    if (world.isError) return { isError: true, result: 'Exit code 1', text: `Exit code 1\n${world.stdout ?? LONG}` }
    return { result: { stdout: world.stdout ?? LONG, stderr: '', interrupted: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { written, ran }
}

test('which commands are digested, and where a test report is', () => {
  expect(isUnityOutputCommand('unity test MonJeu --mode EditMode')).toBe(true)
  expect(isUnityOutputCommand('/Applications/Unity/Hub/Editor/6000.3.10f1/Unity.app/Contents/MacOS/Unity -batchmode -projectPath MonJeu -runTests')).toBe(true)
  expect(isUnityOutputCommand('tail -n 500 ~/Library/Logs/Unity/Editor.log')).toBe(true)
  expect(isUnityOutputCommand('git status')).toBe(false)
  expect(isUnityOutputCommand('npm run unity-docs')).toBe(false)
  expect(reportPathOf('unity test MonJeu --output Logs/r.xml')).toBe('Logs/r.xml')
  expect(reportPathOf('unity test MonJeu')).toBe('test-results.xml')
  expect(reportPathOf('unity build MonJeu')).toBeNull()
})

test('a short output is left alone', () => {
  expect(digestOutput('ok\ndone', {})).toBeNull()
})

test('a long build log becomes a digest with the C# errors and the end', () => {
  const d = digestOutput(LONG, { fullPath: 'MonJeu/Logs/full.log' })!
  expect(d.text.split('\n').length).toBeLessThan(40)
  expect(d.text).toContain('Sortie complète : MonJeu/Logs/full.log')
  expect(d.text).toContain('Erreurs C# (1) :\n- Assets/Scripts/Player.cs:42:13 CS0103')
  expect(d.text).toContain('Avertissements C# : 1.')
  expect(d.text).toContain('Error building Player')
  expect(d.text).toContain('Exiting batchmode with return code 1')
  expect(d.summary).toBe('4005 lignes résumées · 1 erreur C#')
})

test('Claude reads the digest, and the full output is kept in the Unity project Logs/', async ($, on) => {
  const { written } = engine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'unity build MonJeu --target StandaloneOSX -o Build/' })
  expect(r.deny).toBeUndefined()
  const stdout = (r.result as { stdout: string }).stdout
  expect(stdout).toContain('unity-log-digest : sortie de 4005 lignes résumée.')
  expect(stdout).toContain('Sortie complète : MonJeu/Logs/claude-unity-output-50000.log')
  expect(written['/repo/MonJeu/Logs/claude-unity-output-50000.log']).toContain('Thing3999')
})

test('a test run is digested from its NUnit report, errors included', async ($, on) => {
  engine(on, { isError: true, report: REPORT })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'unity test MonJeu --mode EditMode --output MonJeu/Logs/r.xml' })
  expect(r.deny).toContain('La commande a échoué.')
  expect(r.deny).toContain('Tests : 2 réussis, 1 en échec, 0 ignorés (rapport MonJeu/Logs/r.xml).')
  expect(r.deny).toContain('- T.B (/repo/MonJeu/Assets/Tests/B.cs:9) : Expected 1 but was 2')
})

test('a unity command that does not name the project is refused', async ($, on) => {
  const { ran } = engine(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'unity test --mode EditMode' })
  expect(r.deny).toContain('unity test MonJeu --mode EditMode')
  expect(ran).toHaveLength(0)
  const ok = await $.tool.call({ tool: 'Bash', command: 'cd MonJeu && unity test . --mode EditMode' })
  expect(ok.deny).toBeUndefined()
})

test('other commands pass untouched', async ($, on) => {
  engine(on, { stdout: 'x\n'.repeat(500) })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'git log --oneline' })
  expect((r.result as { stdout: string }).stdout).toBe('x\n'.repeat(500))
})

test('the call row gets one dim line under the engine’s own', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'unity build MonJeu --target StandaloneOSX -o Build/', tool_use_id: 'toolu_1' } as never)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'unity-log-digest',
      surface,
      component: 'ToolUse',
      requestId: 'toolu_1',
      props: { tool_use_id: 'toolu_1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /unity-log-digest/ }))?.text).toContain('4005 lignes résumées · 1 erreur C#')
    await ui.unmount()
  }
})
