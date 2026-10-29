// Reads the NUnit 3 report Unity's test runner writes (kept identical in
// unity-test-runner and unity-log-digest).

export type TestFailure = { name: string; message: string; file: string | null; line: number | null }

export type TestReport = {
  total: number
  passed: number
  failed: number
  skipped: number
  durationS: number | null
  failures: TestFailure[]
}

const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
const num = (v: string | undefined): number => (v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v))

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// Unity's traces end frames with "in /path/File.cs:42" or "(at Assets/File.cs:42)".
export function locate(stack: string): { file: string | null; line: number | null } {
  const m = stack.match(/(?:\bin |\(at )([^\s()]+\.cs):(\d+)/)
  return m?.[1] && m[2] ? { file: m[1], line: Number(m[2]) } : { file: null, line: null }
}

export function parseNUnit(xml: string): TestReport | null {
  const run = xml.match(/<test-run\b[^>]*>/)?.[0]
  if (!run) return null
  const failures: TestFailure[] = []
  // A passed case is often self-closing (<test-case ... />): it has no body to read.
  for (const m of xml.matchAll(/<test-case\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-case>)/g)) {
    const [, head = '', body = ''] = m
    if (attr(head, 'result') !== 'Failed') continue
    const message = unescapeXml(body.match(/<message>([\s\S]*?)<\/message>/)?.[1] ?? '').trim()
    const stack = unescapeXml(body.match(/<stack-trace>([\s\S]*?)<\/stack-trace>/)?.[1] ?? '')
    failures.push({ name: attr(head, 'fullname') ?? attr(head, 'name') ?? '?', message: message.split('\n')[0] ?? '', ...locate(stack) })
  }
  const duration = attr(run, 'duration')
  return {
    total: num(attr(run, 'total')),
    passed: num(attr(run, 'passed')),
    failed: num(attr(run, 'failed')),
    skipped: num(attr(run, 'skipped')) + num(attr(run, 'inconclusive')),
    durationS: duration === undefined ? null : Math.round(num(duration) * 10) / 10,
    failures,
  }
}

export function failuresAsText(failures: readonly TestFailure[]): string {
  return failures
    .map(f => `- ${f.name}${f.file ? ` (${f.file}:${f.line})` : ''} : ${f.message}`)
    .join('\n')
}
