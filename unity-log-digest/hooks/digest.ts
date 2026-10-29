// Pure part of unity-log-digest: which shell commands print Unity's long
// output, and the short digest Claude reads in their place.
import type { TestReport } from './nunit'
import { failuresAsText } from './nunit'

// `unity test|build|run`, the Unity binary in batch mode, or a read of Editor.log.
const UNITY_CLI = /(^|[\s;&|(])unity\s+(test|build|run)\b/
const UNITY_BATCH = /(^|[\s;&|(/\\"'])Unity(\.exe)?["']?\s[^;&|]*-batchmode\b/
const EDITOR_LOG = /\bEditor(-prev)?\.log\b/
const CS_DIAGNOSTIC = /^(.+?\.cs)\((\d+),(\d+)\): (error|warning) (CS\d{4}): (.*)$/gm
const OTHER_ERROR = /\b(error|exception|failed|failure|aborting)\b/i

export const MIN_LINES = 60
const TAIL = 15
const LIST_MAX = 15

export function isUnityOutputCommand(command: string): boolean {
  return UNITY_CLI.test(command) || UNITY_BATCH.test(command) || EDITOR_LOG.test(command)
}

export function isUnityCliCommand(command: string): boolean {
  return UNITY_CLI.test(command)
}

export function words(command: string): string[] {
  return command
    .split(/\s+/)
    .map(w => w.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

// The report a test run writes: --output (CLI) or -testResults (Unity), else the CLI's default.
export function reportPathOf(command: string): string | null {
  if (!/\bunity\s+test\b|-runTests\b/.test(command)) return null
  const w = words(command)
  for (const flag of ['--output', '-testResults']) {
    const i = w.indexOf(flag)
    if (i !== -1 && w[i + 1]) return w[i + 1]!
  }
  return /\bunity\s+test\b/.test(command) ? 'test-results.xml' : null
}

export type Digest = { text: string; summary: string }

export function digestOutput(
  output: string,
  extra: { report?: TestReport | null; reportPath?: string | null; fullPath?: string | null },
): Digest | null {
  const lines = output.trimEnd().split(/\r?\n/)
  if (lines.length < MIN_LINES) return null

  const seen = new Set<string>()
  const errors: string[] = []
  let warnings = 0
  for (const m of output.matchAll(CS_DIAGNOSTIC)) {
    const [line = '', file, row, col, severity, code, message] = m
    if (seen.has(line)) continue
    seen.add(line)
    if (severity === 'warning') warnings += 1
    else errors.push(`- ${file}:${row}:${col} ${code} : ${message?.trim()}`)
  }
  const others = [...new Set(lines.map(l => l.trim()).filter(l => OTHER_ERROR.test(l) && !/\bCS\d{4}\b/.test(l)))].map(
    l => `- ${l.slice(0, 300)}`,
  )
  const tail = lines.map(l => l.trimEnd()).filter(Boolean).slice(-TAIL)

  const out = [`unity-log-digest : sortie de ${lines.length} lignes résumée.${extra.fullPath ? ` Sortie complète : ${extra.fullPath}` : ''}`]
  const r = extra.report
  if (r) {
    out.push(`Tests : ${r.passed} réussis, ${r.failed} en échec, ${r.skipped} ignorés${extra.reportPath ? ` (rapport ${extra.reportPath})` : ''}.`)
    if (r.failures.length > 0) out.push(failuresAsText(r.failures.slice(0, LIST_MAX)))
  }
  if (errors.length > 0) out.push(`Erreurs C# (${errors.length}) :`, ...errors.slice(0, LIST_MAX))
  if (warnings > 0) out.push(`Avertissements C# : ${warnings}.`)
  if (others.length > 0) out.push(`Autres lignes d'erreur (${others.length}) :`, ...others.slice(0, LIST_MAX))
  out.push(`Fin de la sortie :`, ...tail)

  const parts = [`${lines.length} lignes résumées`]
  if (r) parts.push(`tests ${r.passed} ✓ ${r.failed} ✗`)
  if (errors.length > 0) parts.push(`${errors.length} erreur${errors.length > 1 ? 's' : ''} C#`)
  return { text: out.join('\n'), summary: parts.join(' · ') }
}
