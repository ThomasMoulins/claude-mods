export type Diagnostic = {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning'
  code: string
  message: string
}

export type ConsoleState = 'no-project' | 'no-log' | 'other-project' | 'idle' | 'compiling' | 'ok' | 'errors'

export type ConsoleReport = {
  state: ConsoleState
  errors: Diagnostic[]
  warningCount: number
  project: string | null
  // The Unity project the mods follow, relative to the session's root, and how it was chosen.
  unityRel: string | null
  note: string
  logPath: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'unity-console': { report: Shaped<ConsoleReport> }
  }
}
