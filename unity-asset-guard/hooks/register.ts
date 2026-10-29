import type { EngineInterface, Register } from 'claude-code'

import { resolveUnityProject, unityProjectCommand } from './project'
import type { UnityProject } from './project'
import { judgeCommand, judgeEdit, relativeTo } from './rules'
import type { Verdict } from './rules'

const ALLOW_ONCE = 'Autoriser une fois'
const REFUSE = 'Refuser'

// Unity holds this file for as long as an Editor has the project open.
async function isEditorOpen($: EngineInterface, project: UnityProject): Promise<boolean> {
  return project.dir !== null && $.fs.exists(`${project.dir}/Temp/UnityLockfile`)
}

// The reason to refuse the call, or null to let it run; asks the user when the verdict says so.
async function refusal($: EngineInterface, verdict: Verdict): Promise<string | null> {
  if (verdict.kind === 'allow') return null
  if (verdict.kind === 'deny') return `${$.plugin.name} : ${verdict.reason}`
  let answer = REFUSE
  try {
    answer = await $.ui.ask(verdict.question, { header: 'Unity', options: [ALLOW_ONCE, REFUSE] })
  } catch {
    // Dismissed, or nobody to ask (claude -p): refuse.
  }
  return answer === ALLOW_ONCE ? null : `${$.plugin.name} : ${verdict.refusal}`
}

async function fileVerdict($: EngineInterface, filePath: string, isWrite: boolean): Promise<Verdict> {
  const project = await resolveUnityProject($)
  return judgeEdit({
    rel: relativeTo(project.root, filePath),
    unityDir: project.rel,
    isWrite,
    exists: await $.fs.exists(filePath),
    editorOpen: await isEditorOpen($, project),
  })
}

async function commandVerdict($: EngineInterface, command: string): Promise<Verdict> {
  const project = await resolveUnityProject($)
  return judgeCommand(command, project.root, project.rel, await isEditorOpen($, project))
}

const FAILED = (name: string) => `${name} : la garde a échoué, l'appel est refusé par prudence.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({
        name: 'unity-project',
        description: 'Affiche ou règle le dossier du projet Unity suivi par les mods',
        argumentHint: '[dossier | auto]',
        immediate: true,
      })
    } catch {
      // unity-console registered it first: its answer does the same.
    }
    return started
  })

  on('command.run', { command: 'unity-project' }, async ($, e) => ({ text: await unityProjectCommand($, e.args) }))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await refusal($, await fileVerdict($, e.file_path, false))
    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED($.plugin.name) }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await refusal($, await fileVerdict($, e.file_path, true))
    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED($.plugin.name) }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await refusal($, await commandVerdict($, e.command))
    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED($.plugin.name) }))

  // Windows builds run shell commands through PowerShell, a tool this build's
  // types may not list: matched by name, its command read untyped. Its rm, mv
  // and git are read like Bash's; Remove-Item and Move-Item are not.
  on('tool.call', { tool: /^PowerShell$/ }, async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    const deny = typeof command === 'string' ? await refusal($, await commandVerdict($, command)) : null
    return deny === null ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED($.plugin.name) }))
}
