export type CiRun = {
  id: number
  workflow: string
  title: string
  // queued, in_progress or completed; conclusion once completed.
  status: string
  conclusion: string | null
  createdAt: number
  url: string
  failedJobs: string[]
}

export type CiSnapshot = {
  state: 'loading' | 'ready' | 'error' | 'no-branch'
  branch: string | null
  runs: CiRun[]
  error: string | null
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'unity-ci-status': { ci: Shaped<CiSnapshot> }
  }
}
