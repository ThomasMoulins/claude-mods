import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { judgeCommand, judgeEdit } from '../hooks/rules'

const ROOT = '/repo'
const SCENE = `${ROOT}/MonJeu/Assets/Scenes/ChestScene.unity`
const SCRIPT = `${ROOT}/MonJeu/Assets/Scripts/Player/PlayerController.cs`

type World = { editorOpen?: boolean; answer?: string | null; existing?: string[]; config?: string }

// Stands for the engine beneath the guard: the tool always succeeds, and the
// question is answered as `world.answer` says (null: dismissed).
function engine(on: On, world: World = {}) {
  const asked: string[] = []
  const ran: string[] = []
  const config = `${ROOT}/.claude/claude-mods.json`
  on('session.root', () => ({ value: ROOT }))
  // The disk: one Unity project, MonJeu/, next to a stray ProjectSettings/ at the root.
  on('fs.exists', (_, e) => ({
    value: e.path.endsWith('/Temp/UnityLockfile')
      ? world.editorOpen === true
      : e.path === `${ROOT}/MonJeu/ProjectSettings/ProjectVersion.txt` ||
        e.path === `${ROOT}/ProjectSettings/ProjectVersion.txt` ||
        (world.existing ?? [SCENE, SCRIPT]).includes(e.path),
  }))
  on('fs.list', (_, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    if (e.path === ROOT) return { value: [dir('MonJeu'), dir('Documentation')] }
    if (e.path === `${ROOT}/MonJeu/Assets`) return { value: [dir('Scenes')] }
    if (e.path === `${ROOT}/Assets`) return { value: [] }
    return { deny: 'ENOENT' }
  })
  on('fs.stat', (_, e) => (e.path === config && world.config ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', (_, e) => (e.path === config && world.config ? { value: world.config } : { deny: 'ENOENT' }))
  // $.ui.ask is a call of the AskUserQuestion tool.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    if (world.answer === null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: world.answer ?? 'Refuser' } } as never }
  })
  on('tool.call', (_, e) => {
    ran.push(e.tool)
    return { result: { ok: true } as never }
  })
  return { asked, ran }
}

const edit = (file_path: string) => ({ tool: 'Edit' as const, file_path, old_string: 'a', new_string: 'b' })
const bash = (command: string) => ({ tool: 'Bash' as const, command })

describe('file edits', () => {
  test('a C# script is edited without a question', async ($, on) => {
    const { asked, ran } = engine(on)
    const r = await $.tool.call(edit(SCRIPT))
    expect(r.deny).toBeUndefined()
    expect(asked).toHaveLength(0)
    expect(ran).toEqual(['Edit'])
  })

  test('a scene is refused outright while the Editor is open', async ($, on) => {
    const { asked, ran } = engine(on, { editorOpen: true })
    const r = await $.tool.call(edit(SCENE))
    expect(r.deny).toContain("l'Editor Unity est ouvert")
    expect(asked).toHaveLength(0)
    expect(ran).toHaveLength(0)
  })

  test('a scene asks first when the Editor is closed, and a refusal stops it', async ($, on) => {
    const { asked, ran } = engine(on, { answer: 'Refuser' })
    const r = await $.tool.call(edit(SCENE))
    expect(asked[0]).toContain('MonJeu/Assets/Scenes/ChestScene.unity')
    expect(r.deny).toContain('refusé')
    expect(ran).toHaveLength(0)
  })

  test('"Autoriser une fois" lets the edit run', async ($, on) => {
    const { ran } = engine(on, { answer: 'Autoriser une fois' })
    const r = await $.tool.call(edit(SCENE))
    expect(r.deny).toBeUndefined()
    expect(ran).toEqual(['Edit'])
  })

  test('a dismissed question refuses', async ($, on) => {
    const { ran } = engine(on, { answer: null })
    const r = await $.tool.call(edit(SCENE))
    expect(r.deny).toBeDefined()
    expect(ran).toHaveLength(0)
  })

  test('a .meta is never written from scratch, and .lfsconfig and Library/ never touched', async ($, on) => {
    const { asked, ran } = engine(on, { answer: 'Autoriser une fois' })
    const meta = await $.tool.call({ tool: 'Write', file_path: `${SCRIPT}.meta`, content: 'guid: 0' })
    expect(meta.deny).toContain('Unity génère les .meta')
    const lfs = await $.tool.call(edit(`${ROOT}/.lfsconfig`))
    expect(lfs.deny).toContain('.lfsconfig')
    const library = await $.tool.call(edit(`${ROOT}/MonJeu/Library/LastSceneManagerSetup.txt`))
    expect(library.deny).toContain('MonJeu/Library')
    expect(asked).toHaveLength(0)
    expect(ran).toHaveLength(0)
  })

  test('the guard follows the Unity folder set in .claude/claude-mods.json', async ($, on) => {
    // Configured elsewhere: MonJeu/Library is no longer a generated folder of the project.
    const { ran } = engine(on, { config: JSON.stringify({ unityProject: 'Game' }), existing: [] })
    const r = await $.tool.call(edit(`${ROOT}/MonJeu/Library/notes.txt`))
    expect(r.deny).toBeUndefined()
    const game = await $.tool.call(edit(`${ROOT}/Game/Temp/x.txt`))
    expect(game.deny).toContain('Game/Temp')
    expect(ran).toEqual(['Edit'])
  })
})

describe('shell commands', () => {
  test('deleting or moving a script without its .meta is refused', async ($, on) => {
    const { ran } = engine(on)
    const rm = await $.tool.call(bash('rm MonJeu/Assets/Scripts/Player/PlayerController.cs'))
    expect(rm.deny).toContain('PlayerController.cs.meta')
    const mv = await $.tool.call(bash('git mv MonJeu/Assets/Scripts/A.cs MonJeu/Assets/Scripts/B.cs'))
    expect(mv.deny).toContain('A.cs.meta')
    expect(ran).toHaveLength(0)
  })

  test('moving a script with its .meta goes through', async ($, on) => {
    const { asked, ran } = engine(on)
    const r = await $.tool.call(
      bash('git mv MonJeu/Assets/Scripts/A.cs MonJeu/Assets/Scripts/B.cs && git mv MonJeu/Assets/Scripts/A.cs.meta MonJeu/Assets/Scripts/B.cs.meta'),
    )
    expect(r.deny).toBeUndefined()
    expect(asked).toHaveLength(0)
    expect(ran).toEqual(['Bash'])
  })

  test('commands that discard work ask first', async ($, on) => {
    const { asked } = engine(on, { answer: 'Refuser' })
    for (const command of ['git reset --hard', 'git checkout -- .', 'git clean -fd', 'git restore MonJeu/Assets']) {
      const r = await $.tool.call(bash(command))
      expect(r.deny).toBeDefined()
    }
    expect(asked).toHaveLength(4)
  })

  test('sed -i on a prefab asks, and ordinary commands pass silently', async ($, on) => {
    const { asked, ran } = engine(on, { answer: 'Refuser' })
    const sed = await $.tool.call(bash("sed -i '' 's/a/b/' MonJeu/Assets/Prefabs/Chest.prefab"))
    expect(sed.deny).toBeDefined()
    for (const command of ['git status', 'ls MonJeu/Assets', 'cat MonJeu/Assets/Scenes/ChestScene.unity | head', 'git checkout dev', 'unity test MonJeu --mode EditMode 2>&1 | tail -5']) {
      const r = await $.tool.call(bash(command))
      expect(r.deny).toBeUndefined()
    }
    expect(asked).toHaveLength(1)
    expect(ran).toHaveLength(5)
  })
})

test('quotes keep a path with spaces together', () => {
  const v = judgeCommand('rm "MonJeu/Assets/TextMesh Pro/Fonts/A.ttf"', ROOT, 'MonJeu', false)
  expect(v.kind).toBe('deny')
  expect(v.kind === 'deny' && v.reason).toContain('TextMesh Pro/Fonts/A.ttf.meta')
})

test('Windows paths with backslashes are guarded like the others', () => {
  const v = judgeEdit({ rel: 'MonJeu\\Assets\\Scenes\\A.unity'.replace(/\\/g, '/'), unityDir: 'MonJeu', isWrite: false, exists: true, editorOpen: true })
  expect(v.kind).toBe('deny')
  const w = judgeCommand("rm 'C:\\Game\\MonJeu\\Assets\\A.cs'", 'C:\\Game', 'MonJeu', false)
  expect(w.kind === 'deny' && w.reason).toContain('MonJeu/Assets/A.cs.meta')
})

test('generated folders and .lfsconfig: writes are refused, reads and here-document data are not', () => {
  const check = (command: string) => judgeCommand(command, ROOT, 'MonJeu', false).kind
  expect(check('rm -rf MonJeu/Library')).toBe('deny')
  expect(check('cp notes.txt MonJeu/Temp/notes.txt')).toBe('deny')
  expect(check('git add MonJeu/UserSettings')).toBe('deny')
  expect(check('sed -i "" s/a/b/ .lfsconfig')).toBe('deny')
  expect(check('echo x > MonJeu/Logs/out.log')).toBe('deny')
  expect(check('cp MonJeu/Library/LastSceneManagerSetup.txt /tmp/scenes.txt')).toBe('allow')
  expect(check('node check.mts MonJeu/Logs/x.log')).toBe('allow')
  expect(check('cat .lfsconfig')).toBe('allow')
  expect(check("cat > /tmp/s.mts <<'EOF'\nconst p = 'MonJeu/Logs/x.log'\nrm MonJeu/Library/x\nEOF\nnode /tmp/s.mts")).toBe('allow')
  expect(check('cat > MonJeu/Logs/x.log <<EOF\nhello\nEOF')).toBe('deny')
  expect(check('cat <<<"MonJeu/Library" | wc -c')).toBe('allow')
})
