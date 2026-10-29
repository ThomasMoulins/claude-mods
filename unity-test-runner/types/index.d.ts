export type TestMode = 'EditMode' | 'PlayMode'

export type TestRunFailure = { name: string; message: string; file: string | null; line: number | null }

export type TestRun = {
  state: 'idle' | 'running' | 'passed' | 'failed' | 'error' | 'blocked'
  modes: TestMode[]
  // The mode running now, while `state` is running.
  current: TestMode | null
  filter: string
  startedAt: number
  durationMs: number
  total: number
  passed: number
  failed: number
  skipped: number
  failures: TestRunFailure[]
  message: string
  // The run's last lines of output, for a run that ended without a report.
  tail: string[]
  reports: string[]
  unityRel: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'unity-test-runner': { run: Shaped<TestRun> }
  }
}
