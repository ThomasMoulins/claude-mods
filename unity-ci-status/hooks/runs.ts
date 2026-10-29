import type { CiRun } from '../types'

type RawRun = {
  databaseId?: unknown
  workflowName?: unknown
  displayTitle?: unknown
  status?: unknown
  conclusion?: unknown
  createdAt?: unknown
  url?: unknown
}

// The newest run of each workflow, from `gh run list --json ...` (newest first).
export function latestRuns(json: string, only: readonly string[] | undefined): CiRun[] {
  const seen = new Set<string>()
  const runs: CiRun[] = []
  for (const raw of JSON.parse(json) as RawRun[]) {
    const workflow = typeof raw.workflowName === 'string' ? raw.workflowName : '?'
    if (seen.has(workflow) || (only && only.length > 0 && !only.includes(workflow))) continue
    seen.add(workflow)
    runs.push({
      id: typeof raw.databaseId === 'number' ? raw.databaseId : 0,
      workflow,
      title: typeof raw.displayTitle === 'string' ? raw.displayTitle : '',
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      conclusion: typeof raw.conclusion === 'string' && raw.conclusion !== '' ? raw.conclusion : null,
      createdAt: typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : 0,
      url: typeof raw.url === 'string' ? raw.url : '',
      failedJobs: [],
    })
  }
  return runs
}

export function failedJobs(json: string): string[] {
  const { jobs = [] } = JSON.parse(json) as { jobs?: { name?: unknown; conclusion?: unknown }[] }
  return jobs.filter(j => j.conclusion === 'failure' || j.conclusion === 'timed_out').map(j => String(j.name ?? '?'))
}

export const isRunning = (r: CiRun) => r.status !== 'completed'
export const isFailed = (r: CiRun) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'startup_failure'

export function icon(r: CiRun): string {
  if (isRunning(r)) return '⏳'
  if (isFailed(r)) return '✗'
  if (r.conclusion === 'success') return '✓'
  return '·'
}

export function age(now: number, then: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `il y a ${hours} h`
  return `il y a ${Math.round(hours / 24)} j`
}

export function statusLine(branch: string, runs: readonly CiRun[], now: number): string {
  if (runs.length === 0) return `CI ${branch} : aucun run`
  const running = runs.filter(isRunning)
  const failed = runs.filter(isFailed)
  if (failed.length > 0) {
    const first = failed[0]!
    const jobs = first.failedJobs.length > 0 ? ` (${first.failedJobs.join(', ')})` : ''
    return `CI ${branch} : ✗ ${first.workflow}${jobs}${failed.length > 1 ? ` +${failed.length - 1}` : ''} · /ci`
  }
  if (running.length > 0) return `CI ${branch} : ⏳ ${running.map(r => r.workflow).join(', ')} en cours`
  const newest = Math.max(...runs.map(r => r.createdAt))
  return `CI ${branch} : ✓ ${runs.length} workflow${runs.length > 1 ? 's' : ''} (${age(now, newest)})`
}
