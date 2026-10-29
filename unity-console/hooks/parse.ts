import type { ConsoleState, Diagnostic } from '../types'

// Markers read from a real Unity 6000.3 Editor.log (macOS).
const COMPILE_START = '[ScriptCompilation] Requested script compilation because:'
const COMPILE_DONE = /AssetDatabase: script compilation time:|Reloading assemblies|Domain Reload Profiling:|Scripts have compiler errors/
const PROJECT = /^Successfully changed project path to: (.+)$/gm
// Roslyn's line as Unity logs it: Assets/Scripts/Foo.cs(12,5): error CS0103: ...
const DIAGNOSTIC = /^(.+?\.cs)\((\d+),(\d+)\): (error|warning) (CS\d{4}): (.*)$/gm

export type ParsedLog = {
  state: Exclude<ConsoleState, 'no-project' | 'no-log' | 'other-project'>
  errors: Diagnostic[]
  warningCount: number
  project: string | null
}

// Reads the last compilation of an Editor.log: the text after the last
// compile request, so errors fixed by a later compile no longer show.
export function parseEditorLog(text: string): ParsedLog {
  const projects = [...text.matchAll(PROJECT)]
  const project = projects.at(-1)?.[1]?.trim() ?? null

  const start = text.lastIndexOf(COMPILE_START)
  const segment = start === -1 ? text : text.slice(start)

  const seen = new Set<string>()
  const errors: Diagnostic[] = []
  let warningCount = 0
  for (const m of segment.matchAll(DIAGNOSTIC)) {
    const [, file = '', line = '0', column = '0', severity, code = '', message = ''] = m
    const id = `${file}|${line}|${column}|${code}|${message}`
    if (seen.has(id)) continue
    seen.add(id)
    if (severity === 'warning') {
      warningCount += 1
      continue
    }
    errors.push({ file, line: Number(line), column: Number(column), severity: 'error', code, message: message.trim() })
  }

  let state: ParsedLog['state']
  if (errors.length > 0) state = 'errors'
  else if (start === -1) state = 'idle'
  else state = COMPILE_DONE.test(segment) ? 'ok' : 'compiling'

  return { state, errors, warningCount, project }
}

// Paths in the log are relative to the Unity project; Claude works from the repo root.
export function repoPath(file: string, unityDir: string): string {
  const path = file.replace(/\\/g, '/')
  if (unityDir === '.' || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith(`${unityDir}/`)) return path
  return `${unityDir}/${path}`
}

export function errorsAsText(errors: readonly Diagnostic[], unityDir: string): string {
  return errors
    .map(d => `- ${repoPath(d.file, unityDir)}:${d.line}:${d.column} ${d.code} : ${d.message}`)
    .join('\n')
}
