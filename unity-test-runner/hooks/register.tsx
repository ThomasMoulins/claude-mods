import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TestMode, TestRun } from '../types'
import { failuresAsText, parseNUnit } from './nunit'
import { modsHelpCommand, readConfig, registerModsHelp, relativeTo, resolveUnityProject, toSlash } from './project'

const PANE = 'unity-test-runner'
const TAIL_LINES = 25
// `unity test` exit codes: 0 all passed, 8 tests failed; anything else, no verdict.
const EXIT_TESTS_FAILED = 8

const IDLE: TestRun = {
  state: 'idle',
  modes: [],
  current: null,
  filter: '',
  startedAt: 0,
  durationMs: 0,
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  failures: [],
  message: '',
  tail: [],
  reports: [],
  unityRel: null,
}
const run = atom({ plugin: 'unity-test-runner', key: 'run' } as const, IDLE, { shape: 'run-1' })

let isRunning = false
let isCancelled = false
let lastArgs = ''

export function parseArgs(args: string): { modes: TestMode[]; filter: string } {
  const [first = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const word = first.toLowerCase()
  if (word === 'all' || word === 'tout') return { modes: ['EditMode', 'PlayMode'], filter: rest.join(' ') }
  if (word === 'play' || word === 'playmode') return { modes: ['PlayMode'], filter: rest.join(' ') }
  if (word === 'edit' || word === 'editmode') return { modes: ['EditMode'], filter: rest.join(' ') }
  return { modes: ['EditMode'], filter: args.trim() }
}

// The Unity CLI: the configured one, `unity` on PATH, then its default install
// folder, since an app started from the Dock does not read the shell's PATH.
async function unityCandidates($: EngineInterface, configured: string | undefined): Promise<string[]> {
  if (configured) return [configured]
  const home = toSlash((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')
  return ['unity', `${home}/.unity/bin/unity`, `${home}/.unity/bin/unity.exe`]
}

async function runMode(
  $: EngineInterface,
  cli: string,
  dir: string,
  mode: TestMode,
  filter: string,
  report: string,
): Promise<{ code: number | null; tail: string[]; didStart: boolean }> {
  const argv = [cli, 'test', dir, '--mode', mode, '--output', report, '--no-banner', '--non-interactive', ...(filter ? ['--filter', filter] : [])]
  const stream = $.process.spawn({ argv, env: { UNITY_NO_PAGER: '1', UNITY_NO_UPDATE_CHECK: '1' } })
  const tail: string[] = []
  let pending = ''
  try {
    for await (const chunk of stream) {
      if (isCancelled) break
      const lines = (pending + chunk.text).split(/\r?\n/)
      pending = lines.pop() ?? ''
      tail.push(...lines.filter(l => l.trim() !== ''))
      tail.splice(0, Math.max(0, tail.length - TAIL_LINES))
    }
  } catch {
    // The first pull rejects when the program cannot start.
    return { code: null, tail, didStart: false }
  }
  if (pending.trim()) tail.push(pending)
  const end = await stream.result.catch(() => ({ code: null, signal: 'killed' }))
  return { code: end.code, tail: tail.slice(-TAIL_LINES), didStart: true }
}

async function startRun($: EngineInterface, args: string): Promise<string> {
  if (isRunning) return 'Des tests Unity tournent déjà : regarde le panneau (/unity-test sans argument).'
  const project = await resolveUnityProject($)
  if (project.dir === null) return 'Aucun projet Unity trouvé : indique-le avec /unity-project <dossier>.'
  const { modes, filter } = parseArgs(args)
  lastArgs = args
  const startedAt = await $.clock.now()
  const base: TestRun = { ...IDLE, modes, filter, startedAt, unityRel: project.rel }

  if (await $.fs.exists(`${project.dir}/Temp/UnityLockfile`)) {
    await update($, run, () => ({
      ...base,
      state: 'blocked' as const,
      message: "L'Editor Unity a le projet ouvert : ferme-le pour lancer les tests en batch, ou lance-les depuis Window > General > Test Runner.",
    }))
    return 'Tests non lancés : l’Editor Unity a le projet ouvert.'
  }

  isRunning = true
  isCancelled = false
  void (async () => {
    try {
      const totals = { total: 0, passed: 0, failed: 0, skipped: 0 }
      const failures: TestRun['failures'] = []
      const reports: string[] = []
      let tail: string[] = []
      let error = ''
      try {
        const config = await readConfig($, project.root)
        const candidates = await unityCandidates($, config.unityCli)
        for (const mode of modes) {
          await update($, run, r => ({ ...(r ?? base), ...base, state: 'running' as const, current: mode, ...totals, failures, reports }))
          $.ui.status(`⏳ tests Unity ${mode} en cours… · /unity-test`)
          const report = `${project.dir}/Logs/claude-tests-${mode}.xml`
          let ended: Awaited<ReturnType<typeof runMode>> | null = null
          for (const cli of candidates) {
            ended = await runMode($, cli, project.dir!, mode, filter, report)
            if (ended.didStart) break
          }
          if (isCancelled) {
            error = 'Tests arrêtés.'
            break
          }
          if (ended === null || !ended.didStart) {
            error = 'La CLI Unity est introuvable. Installe-la, ou indique son chemin dans .claude/claude-mods.json (« unityCli »).'
            break
          }
          tail = ended.tail
          const parsed = (await $.fs.exists(report)) ? parseNUnit(await $.fs.read(report)) : null
          if (parsed !== null && (ended.code === 0 || ended.code === EXIT_TESTS_FAILED)) {
            totals.total += parsed.total
            totals.passed += parsed.passed
            totals.failed += parsed.failed
            totals.skipped += parsed.skipped
            failures.push(...parsed.failures.map(f => ({ ...f, file: f.file ? relativeTo(project.root, f.file) : null })))
            reports.push(relativeTo(project.root, report))
          } else {
            error = `Les tests ${mode} n'ont pas abouti (code ${ended.code ?? '?'}) : erreur de compilation, licence ou Editor. Voir les dernières lignes ci-dessous.`
            break
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      const durationMs = (await $.clock.now()) - startedAt
      const state: TestRun['state'] = error ? 'error' : totals.failed > 0 ? 'failed' : 'passed'
      await update($, run, () => ({ ...base, state, current: null, durationMs, ...totals, failures, reports, tail: error ? tail : [], message: error }))
      if (state === 'passed') $.ui.status(`✓ ${totals.passed} tests Unity réussis`)
      else if (state === 'failed') $.ui.status(`✗ ${totals.failed}/${totals.total} tests Unity en échec · /unity-test`)
      else $.ui.status('✗ tests Unity sans résultat · /unity-test')
      $.ui.toast(state === 'passed' ? `Tests Unity : ${totals.passed} réussis` : state === 'failed' ? `Tests Unity : ${totals.failed} en échec` : 'Tests Unity : pas de résultat')
    } finally {
      isRunning = false
    }
  })()
  return ''
}

function summary(r: TestRun): string {
  const secs = Math.round(r.durationMs / 1000)
  switch (r.state) {
    case 'idle':
      return 'Aucun test lancé. /unity-test [edit|play|all] [filtre]'
    case 'running':
      return `⏳ ${r.current} en cours${r.modes.length > 1 ? ` (${r.modes.join(' puis ')})` : ''}${r.filter ? ` · filtre « ${r.filter} »` : ''}…`
    case 'blocked':
    case 'error':
      return r.message
    case 'passed':
      return `✓ ${r.passed} réussis${r.skipped ? ` · ${r.skipped} ignorés` : ''} · ${secs} s`
    case 'failed':
      return `✗ ${r.failed} en échec · ${r.passed} réussis${r.skipped ? ` · ${r.skipped} ignorés` : ''} · ${secs} s`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'unity-test',
      description: 'Lance les tests Unity et en résume le rapport (EditMode par défaut)',
      argumentHint: '[edit|play|all] [filtre]',
      immediate: true,
    })
    await registerModsHelp($)
    return started
  })

  on('command.run', { command: 'claude-mods' }, async $ => ({ text: await modsHelpCommand($) }))

  on('command.run', { command: 'unity-test' }, async ($, e) => {
    // Without an argument while a run is shown, only the pane opens.
    const text = e.args.trim() === '' && (isRunning || (await read($, run)).state !== 'idle') ? '' : await startRun($, e.args)
    await $.ui.open({ id: PANE, title: 'Tests Unity' })
    return text ? { text } : {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const r = await read($, run)
    const rows = Math.max(2, (e.props.scroll?.bodyRows ?? 20) - 6)
    const shown = r.failures.slice(0, Math.max(1, Math.floor(rows / 2)))
    const text = failuresAsText(r.failures)

    return (
      <Box flexDirection="column">
        <Text weight="semibold" color={r.state === 'passed' ? 'success' : r.state === 'failed' || r.state === 'error' ? 'error' : undefined}>
          {summary(r)}
        </Text>
        {r.reports.length > 0 && <Text dimColor>Rapport : {r.reports.join(', ')}</Text>}
        {shown.map(f => (
          <Box flexDirection="column">
            <Text color="error">
              {f.name}
              {f.file ? ` · ${f.file}:${f.line}` : ''}
            </Text>
            <Text dimColor>  {f.message}</Text>
          </Box>
        ))}
        {r.failures.length > shown.length && <Text dimColor>… et {r.failures.length - shown.length} autre(s)</Text>}
        {r.tail.length > 0 && <Text dimColor>{r.tail.slice(-8).join('\n')}</Text>}
        <Box flexDirection="row" gap={1}>
          {r.state === 'failed' && (
            <Button
              key="send"
              variant="primary"
              label="Envoyer les échecs à Claude"
              onPress={() =>
                void $.prompt
                  .submit({ text: `${r.failed} test(s) Unity en échec (${r.modes.join(', ')}) :\n${text}\n\nCorrige le code, ou le test s'il est faux, en expliquant ton choix.` })
                  .catch(() => $.ui.toast("Impossible d'envoyer les échecs à Claude"))
              }
            />
          )}
          {r.state === 'running' ? (
            <Button key="stop" label="Arrêter" onPress={() => void (isCancelled = true)} />
          ) : (
            <Button key="rerun" label="Relancer" onPress={() => void startRun($, lastArgs)} />
          )}
        </Box>
      </Box>
    )
  })
}
