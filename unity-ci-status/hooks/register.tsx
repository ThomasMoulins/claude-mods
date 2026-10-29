import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CiSnapshot } from '../types'
import { modsHelpCommand, readConfig, registerModsHelp, toSlash } from './project'
import { age, failedJobs, icon, isFailed, latestRuns, statusLine } from './runs'

const PANE = 'unity-ci-status'
const REFRESH_EVERY_MS = 90_000

const EMPTY: CiSnapshot = { state: 'loading', branch: null, runs: [], error: null, fetchedAt: 0 }
const ci = atom({ plugin: 'unity-ci-status', key: 'ci' } as const, EMPTY, { shape: 'ci-1' })

let isRefreshing = false
// Failed jobs per run id: a finished run does not change.
const jobsOfRun = new Map<number, string[]>()
const toastedFailures = new Set<number>()
let hasBaseline = false

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? ''
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const root = toSlash(await $.session.root())
    const git = await $.process.run(['git', 'branch', '--show-current'], { cwd: root })
    const branch = git.exitCode === 0 ? git.stdout.trim() : ''
    if (branch === '') {
      await update($, ci, () => ({ ...EMPTY, state: 'no-branch' as const }))
      $.ui.status(undefined)
      return
    }
    const fields = 'databaseId,workflowName,displayTitle,status,conclusion,createdAt,url'
    const list = await $.process.run(['gh', 'run', 'list', '--branch', branch, '--limit', '30', '--json', fields], { cwd: root, timeoutMs: 60_000 })
    if (list.exitCode !== 0) throw new Error(`gh run list : ${firstLine(list.stderr)}`)
    const { ciWorkflows } = await readConfig($, root)
    const runs = latestRuns(list.stdout, ciWorkflows)
    for (const run of runs.filter(isFailed)) {
      if (!jobsOfRun.has(run.id)) {
        const view = await $.process.run(['gh', 'run', 'view', String(run.id), '--json', 'jobs'], { cwd: root, timeoutMs: 60_000 })
        jobsOfRun.set(run.id, view.exitCode === 0 ? failedJobs(view.stdout) : [])
      }
      run.failedJobs = jobsOfRun.get(run.id) ?? []
    }
    const now = await $.clock.now()
    await update($, ci, () => ({ state: 'ready' as const, branch, runs, error: null, fetchedAt: now }))
    $.ui.status(statusLine(branch, runs, now))
    // The first read only notes the failures already there: a toast is for a new one.
    for (const run of runs.filter(isFailed)) {
      if (hasBaseline && !toastedFailures.has(run.id)) $.ui.toast(`CI ${branch} : ${run.workflow} a échoué`)
      toastedFailures.add(run.id)
    }
    hasBaseline = true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, ci, c => ({ ...(c ?? EMPTY), state: 'error' as const, error: message }))
    $.ui.status('CI illisible · /ci')
  } finally {
    isRefreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void refresh($)
    $.clock.every(REFRESH_EVERY_MS, () => refresh($))
    await $.command.register({ name: 'ci', description: 'Ouvre l’état GitHub Actions de la branche courante et le recharge', immediate: true })
    await registerModsHelp($)
    return started
  })

  on('command.run', { command: 'claude-mods' }, async $ => ({ text: await modsHelpCommand($) }))

  on('command.run', { command: 'ci' }, async $ => {
    void refresh($)
    await $.ui.open({ id: PANE, title: 'CI' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const c = await read($, ci)
    const now = c.fetchedAt || (await $.clock.now())

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text weight="semibold">CI{c.branch ? ` · ${c.branch}` : ''}</Text>
          <Button key="refresh" label="Rafraîchir" onPress={() => void refresh($)} />
        </Box>
        {c.state === 'loading' && <Text dimColor>Chargement…</Text>}
        {c.state === 'no-branch' && <Text dimColor>Pas de branche courante (HEAD détachée, ou pas un dépôt git).</Text>}
        {c.state === 'error' && <Text color="error">{c.error}</Text>}
        {c.state === 'error' && <Text dimColor>Vérifie `gh auth status` : le compte actif doit voir les Actions de ce dépôt.</Text>}
        {c.state === 'ready' && c.runs.length === 0 && <Text dimColor>Aucun run GitHub Actions pour cette branche. Ils démarrent en général à l'ouverture d'une PR.</Text>}
        {c.runs.map(run => (
          <Box flexDirection="column" marginTop={1}>
            <Text color={isFailed(run) ? 'error' : run.conclusion === 'success' ? 'success' : undefined} weight="semibold">
              {icon(run)} {run.workflow} · {age(now, run.createdAt)}
            </Text>
            <Text dimColor>{run.title}</Text>
            {run.failedJobs.length > 0 && <Text color="error">Jobs en échec : {run.failedJobs.join(', ')}</Text>}
            <Box flexDirection="row" gap={1}>
              {run.url !== '' && <Link href={run.url} label="Voir le run" />}
              {isFailed(run) && (
                <Button
                  key={`analyse-${run.id}`}
                  label="Analyser avec Claude"
                  onPress={() =>
                    void $.prompt
                      .submit({
                        text: `Le workflow GitHub Actions « ${run.workflow} » a échoué sur la branche ${c.branch} (${run.url})${run.failedJobs.length > 0 ? `, jobs : ${run.failedJobs.join(', ')}` : ''}.\nLance \`gh run view ${run.id} --log-failed | tail -n 150\`, explique la cause, puis propose une correction sans rien modifier.`,
                      })
                      .catch(() => $.ui.toast("Impossible d'envoyer à Claude"))
                  }
                />
              )}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
