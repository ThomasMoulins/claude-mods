import type { EngineInterface, Register } from 'claude-code'

import { digestOutput, isUnityCliCommand, isUnityOutputCommand, reportPathOf, words } from './digest'
import { parseNUnit } from './nunit'
import type { TestReport } from './nunit'
import { absoluteIn, modsHelpCommand, registerModsHelp, relativeTo, resolveUnityProject, samePath } from './project'
import type { UnityProject } from './project'

// The one-line summary of each digested call, by tool_use_id, for its row.
const summaries = new Map<string, string>()

// A unity CLI command picks its project from the folder it runs in: refuse one
// that does not name the Unity project when the session's root is not it.
function missingProject(command: string, project: UnityProject): string | null {
  if (!isUnityCliCommand(command) || project.dir === null || project.rel === '.') return null
  const names = words(command).some(w => samePath(absoluteIn(project.root, w), project.dir!))
  if (names || /--project-path\b|-projectPath\b/.test(command)) return null
  return (
    `unity-log-digest : la CLI Unity choisit le projet d'après le dossier courant, et la racine n'est pas le projet Unity. ` +
    `Passe-le explicitement, par exemple : unity test ${project.rel} --mode EditMode`
  )
}

async function readReport($: EngineInterface, project: UnityProject, command: string, since: number): Promise<{ report: TestReport | null; path: string | null }> {
  const path = reportPathOf(command)
  if (path === null) return { report: null, path: null }
  const absolute = absoluteIn(project.root, path)
  try {
    const stat = await $.fs.stat(absolute)
    // A report older than this call belongs to an earlier run.
    if (stat.mtimeMs < since - 1000) return { report: null, path: null }
    return { report: parseNUnit(await $.fs.read(absolute)), path: relativeTo(project.root, absolute) }
  } catch {
    return { report: null, path: null }
  }
}

async function keepFullOutput($: EngineInterface, project: UnityProject, output: string, now: number): Promise<string | null> {
  if (project.dir === null) return null
  const path = `${project.dir}/Logs/claude-unity-output-${now}.log`
  try {
    await $.fs.write(path, output.slice(0, 4_000_000))
    return relativeTo(project.root, path)
  } catch {
    return null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerModsHelp($)
    return started
  })

  on('command.run', { command: 'claude-mods' }, async $ => ({ text: await modsHelpCommand($) }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isUnityOutputCommand(e.command) || e.run_in_background) return next(e)
    const project = await resolveUnityProject($)
    const refusal = missingProject(e.command, project)
    if (refusal !== null) return { deny: refusal }

    const since = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const output = ran.isError ? (ran.text ?? '') : `${ran.result.stdout}\n${ran.result.stderr}`
    if (!ran.isError && (ran.result.backgroundTaskId || ran.result.interrupted)) return ran

    const { report, path } = await readReport($, project, e.command, since)
    // Claude Code already kept a long output in a file: point there instead of writing another.
    const persisted = ran.isError ? undefined : ran.result.persistedOutputPath
    const fullPath = persisted ?? (output.split('\n').length >= 60 ? await keepFullOutput($, project, output, since) : null)
    const digest = digestOutput(output, { report, reportPath: path, fullPath })
    if (digest === null) return ran

    summaries.set(e.tool_use_id, digest.summary)
    $.ui.invalidate('ui.render')
    if (ran.isError) return { deny: `La commande a échoué.\n${digest.text}` }
    return { result: { ...ran.result, stdout: digest.text, stderr: '' } }
  })
    // A digest that fails leaves the command and its output as they were.
    .catch(($, e, next) => next(e))

  // Under a digested call's row, one dim line says what Claude read instead.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const summary = summaries.get(e.requestId)
    if (summary === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        {theirs}
        <Text dimColor>  ⎿ unity-log-digest : {summary}</Text>
      </Box>
    )
  })
}
