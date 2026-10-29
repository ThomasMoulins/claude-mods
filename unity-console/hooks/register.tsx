import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ConsoleReport } from '../types'
import { errorsAsText, parseEditorLog, repoPath } from './parse'
import { describeProject, readConfig, resolveUnityProject, samePath, toSlash, unityProjectCommand } from './project'

const PANE = 'unity-console'
const SCAN_EVERY_MS = 3000
// $.fs.read refuses files over 4 MiB; past this size only the end of the log is read.
const MAX_DIRECT_READ = 4_000_000
const TAIL_LINES = 40_000

const EMPTY: ConsoleReport = {
  state: 'no-log',
  errors: [],
  warningCount: 0,
  project: null,
  unityRel: null,
  note: '',
  logPath: '',
  updatedAt: 0,
}
// The tag changes whenever ConsoleReport does: a reload declines the older value.
const report = atom({ plugin: 'unity-console', key: 'report' } as const, EMPTY, { shape: 'report-2' })

let lastSeen = ''
let lastProject: string | null = null
let lastErrorIds = ''

// Where the Editor writes its log: Windows, macOS, then Linux, unless the config names one.
async function editorLogPath($: EngineInterface, configured: string | undefined): Promise<{ path: string; isWindows: boolean }> {
  const local = await $.env.get('LOCALAPPDATA')
  const isWindows = local !== undefined && local !== ''
  if (configured) return { path: toSlash(configured), isWindows }
  if (isWindows) return { path: `${toSlash(local)}/Unity/Editor/Editor.log`, isWindows }
  const home = toSlash((await $.env.get('HOME')) ?? '')
  const mac = `${home}/Library/Logs/Unity/Editor.log`
  if (await $.fs.exists(`${home}/Library/Logs`)) return { path: mac, isWindows }
  return { path: `${home}/.config/unity3d/Editor.log`, isWindows }
}

async function readLog($: EngineInterface, path: string, size: number, isWindows: boolean): Promise<string> {
  if (size <= MAX_DIRECT_READ) return $.fs.read(path)
  const argv = isWindows
    ? ['powershell', '-NoProfile', '-Command', `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail ${TAIL_LINES}`]
    : ['tail', '-n', String(TAIL_LINES), path]
  return (await $.process.run(argv)).stdout
}

function showStatus($: EngineInterface, r: ConsoleReport): void {
  if (r.state === 'errors') {
    const n = r.errors.length
    $.ui.status(`✗ ${n} erreur${n > 1 ? 's' : ''} C# · /unity-errors`)
    const ids = r.errors.map(d => `${d.file}:${d.line}:${d.code}`).join(',')
    if (ids !== lastErrorIds) $.ui.toast(`Unity : ${n} erreur${n > 1 ? 's' : ''} de compilation (/unity-errors)`)
    lastErrorIds = ids
    return
  }
  lastErrorIds = ''
  if (r.state === 'ok') $.ui.status('✓ C# compile')
  else if (r.state === 'compiling') $.ui.status('… compilation C# en cours')
  else $.ui.status(undefined)
}

async function scan($: EngineInterface, force = false): Promise<void> {
  const project = await resolveUnityProject($)
  const config = await readConfig($, project.root)
  const { path, isWindows } = await editorLogPath($, config.editorLog)
  const base = { ...EMPTY, unityRel: project.rel, note: describeProject(project), logPath: path }

  if (project.dir === null) {
    await update($, report, () => ({ ...base, state: 'no-project' as const }))
    $.ui.status(undefined)
    return
  }
  if (!(await $.fs.exists(path))) {
    await update($, report, () => base)
    $.ui.status(undefined)
    return
  }
  const stat = await $.fs.stat(path)
  const seen = `${project.dir}|${path}|${stat.mtimeMs}:${stat.size}`
  if (!force && seen === lastSeen) return
  lastSeen = seen

  const parsed = parseEditorLog(await readLog($, path, stat.size, isWindows))
  // A log read from its end may have lost the project line: keep the last one seen.
  const logProject = parsed.project ?? lastProject
  lastProject = logProject
  const isOtherProject = logProject !== null && !samePath(logProject, project.dir)

  const next: ConsoleReport = {
    ...base,
    state: isOtherProject ? 'other-project' : parsed.state,
    errors: isOtherProject ? [] : parsed.errors,
    warningCount: isOtherProject ? 0 : parsed.warningCount,
    project: logProject,
    updatedAt: await $.clock.now(),
  }
  await update($, report, () => next)
  showStatus($, next)
}

function headline(r: ConsoleReport): string {
  const warnings = r.warningCount > 0 ? `${r.warningCount} avertissement${r.warningCount > 1 ? 's' : ''}` : ''
  switch (r.state) {
    case 'no-project':
      return r.note
    case 'no-log':
      return `Aucun Editor.log trouvé (${r.logPath || 'chemin inconnu'}). Ouvre le projet dans Unity.`
    case 'other-project':
      return `Editor.log concerne un autre projet : ${r.project}`
    case 'idle':
      return 'Editor ouvert, aucune compilation depuis son lancement.'
    case 'compiling':
      return 'Compilation C# en cours…'
    case 'ok':
      return `✓ Le C# compile${warnings ? ` (${warnings})` : ''}.`
    case 'errors': {
      const n = r.errors.length
      return `✗ ${n} erreur${n > 1 ? 's' : ''} de compilation${warnings ? ` · ${warnings}` : ''}`
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void scan($, true).catch(() => undefined)
    $.clock.every(SCAN_EVERY_MS, () => scan($))
    await $.command.register({
      name: 'unity-errors',
      description: 'Ouvre le panneau des erreurs de compilation Unity (lu dans Editor.log)',
      immediate: true,
    })
    try {
      await $.command.register({
        name: 'unity-project',
        description: 'Affiche ou règle le dossier du projet Unity suivi par les mods',
        argumentHint: '[dossier | auto]',
        immediate: true,
      })
    } catch {
      // unity-asset-guard registered it first: its answer does the same.
    }
    return started
  })

  on('command.run', { command: 'unity-errors' }, async $ => {
    await scan($, true)
    await $.ui.open({ id: PANE, title: 'Unity' })
    return {}
  })

  on('command.run', { command: 'unity-project' }, async ($, e) => {
    const text = await unityProjectCommand($, e.args)
    await scan($, true)
    return { text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, report)
    const unityDir = r.unityRel ?? '.'
    const rows = Math.max(1, (e.props.scroll?.bodyRows ?? 20) - 5)
    const shown = r.errors.slice(0, Math.max(1, Math.floor(rows / 2)))
    const text = errorsAsText(r.errors, unityDir)

    return (
      <Box flexDirection="column">
        <Text color={r.state === 'errors' ? 'error' : r.state === 'ok' ? 'success' : undefined} weight="semibold">
          {headline(r)}
        </Text>
        {r.state !== 'no-project' && <Text dimColor>{r.note}</Text>}
        {shown.map(d => (
          <Box flexDirection="column">
            <Text color="error">
              {repoPath(d.file, unityDir)}:{d.line} · {d.code}
            </Text>
            <Text dimColor>  {d.message}</Text>
          </Box>
        ))}
        {r.errors.length > shown.length && <Text dimColor>… et {r.errors.length - shown.length} autre(s)</Text>}
        <Box flexDirection="row" gap={1}>
          {r.state === 'errors' && (
            <Button
              key="send"
              variant="primary"
              label="Envoyer à Claude"
              onPress={() => {
                void $.prompt
                  .submit({ text: `Unity (${unityDir}) a ${r.errors.length} erreur(s) de compilation C# :\n${text}\n\nCorrige-les.` })
                  .catch(() => $.ui.toast("Impossible d'envoyer les erreurs à Claude"))
              }}
            />
          )}
          {r.state === 'errors' && (
            <Button key="copy" label="Copier" onPress={press => void $.ui.copy({ text, surface: press.surface })} />
          )}
          <Button key="refresh" label="Rafraîchir" onPress={() => void scan($, true)} />
        </Box>
      </Box>
    )
  })
}
