// Shared by the claude-mods plugins (kept identical in each): where the Unity
// project and the GitHub project are, from .claude/claude-mods.json at the
// session's root, or detected when the file says nothing.
import type { EngineInterface } from 'claude-code'

export const CONFIG_FILE = '.claude/claude-mods.json'

export type ModsConfig = {
  unityProject?: string
  editorLog?: string
  // The Unity CLI to run, when `unity` is not on the app's PATH.
  unityCli?: string
  github?: { owner: string; number: number }
  // Workflow names unity-ci-status shows; all of them when absent.
  ciWorkflows?: string[]
}

// Every plugin of the claude-mods marketplace, for /claude-mods.
export const MODS = [
  'unity-console',
  'project-board',
  'unity-asset-guard',
  'unity-test-runner',
  'unity-ci-status',
  'unity-log-digest',
  'wwise-soundbank-check',
] as const

export type UnityProject = {
  root: string
  // Absolute path of the Unity project, or null when none is configured or found.
  dir: string | null
  // The same, relative to the root ('.' for the root itself).
  rel: string | null
  source: 'config' | 'detected' | 'none'
  candidates: string[]
}

const SKIP = new Set(['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'node_modules', 'UserSettings'])

export const toSlash = (p: string): string => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
export const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(toSlash(p))
export const samePath = (a: string, b: string): boolean => {
  const [x, y] = [toSlash(a), toSlash(b)]
  return /^[A-Za-z]:\//.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y
}

export function relativeTo(root: string, path: string): string {
  const [r, p] = [toSlash(root), toSlash(path).replace(/^\.\//, '')]
  if (samePath(r, p)) return '.'
  const isWindows = /^[A-Za-z]:\//.test(r)
  const prefix = `${r}/`
  const starts = isWindows ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix)
  return starts ? p.slice(prefix.length) : p
}

// Resolves `.` and `..` segments: /a/b/../c is /a/c.
export function normalize(path: string): string {
  const p = toSlash(path)
  const head = p.startsWith('/') ? '/' : (p.match(/^[A-Za-z]:\//)?.[0] ?? '')
  const parts: string[] = []
  for (const part of p.slice(head.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else parts.push(part)
  }
  return `${head}${parts.join('/')}` || '.'
}

export function absoluteIn(root: string, path: string): string {
  const p = toSlash(path)
  if (isAbsolute(p)) return normalize(p)
  return p === '.' || p === '' ? toSlash(root) : normalize(`${toSlash(root)}/${p}`)
}

// Answers /claude-mods: the commands of the claude-mods plugins loaded in this session.
export async function modsHelpCommand($: EngineInterface): Promise<string> {
  const commands = await $.command.list()
  const names = new Set<string>(MODS)
  const lines: string[] = []
  for (const mod of MODS) {
    const own = commands.filter(c => (c.plugin ?? '').split('@')[0] === mod)
    if (own.length === 0) continue
    lines.push(`**${mod}**`)
    for (const c of own) lines.push(`- /${c.name} : ${c.description}`)
  }
  const loaded = new Set(commands.map(c => (c.plugin ?? '').split('@')[0]).filter(p => names.has(p ?? '')))
  const missing = MODS.filter(m => !loaded.has(m))
  if (missing.length > 0) lines.push('', `Sans commande ou pas installés ici : ${missing.join(', ')}.`)
  return lines.length > 0 ? lines.join('\n') : 'Aucun mod claude-mods ne déclare de commande dans cette session.'
}

// Registers /claude-mods once across the claude-mods plugins: the first one loaded answers it.
export async function registerModsHelp($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: 'claude-mods', description: 'Liste les commandes des mods claude-mods installés', immediate: true })
  } catch {
    // Another claude-mods plugin registered it first.
  }
}

let cachedConfig: { root: string; mtimeMs: number; config: ModsConfig } | null = null
let cachedDetection: { root: string; found: string[] } | null = null

export async function readConfig($: EngineInterface, root: string): Promise<ModsConfig> {
  const file = `${toSlash(root)}/${CONFIG_FILE}`
  try {
    const { mtimeMs } = await $.fs.stat(file)
    if (cachedConfig?.root === root && cachedConfig.mtimeMs === mtimeMs) return cachedConfig.config
    const config = JSON.parse(await $.fs.read(file)) as ModsConfig
    cachedConfig = { root, mtimeMs, config }
    return config
  } catch {
    return {}
  }
}

// Merges `patch` into the file; a key set to undefined is removed.
export async function writeConfig($: EngineInterface, root: string, patch: Partial<ModsConfig>): Promise<ModsConfig> {
  const next: Record<string, unknown> = { ...(await readConfig($, root)) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  await $.fs.write(`${toSlash(root)}/${CONFIG_FILE}`, `${JSON.stringify(next, null, 2)}\n`)
  cachedConfig = null
  return next as ModsConfig
}

export async function isUnityProject($: EngineInterface, dir: string): Promise<boolean> {
  try {
    if (!(await $.fs.exists(`${dir}/ProjectSettings/ProjectVersion.txt`))) return false
    // A stray ProjectSettings/ next to an empty Assets/ is not a project.
    return (await $.fs.list(`${dir}/Assets`)).length > 0
  } catch {
    return false
  }
}

// Unity projects at the root or up to two folders below it, as relative paths.
export async function findUnityProjects($: EngineInterface, root: string): Promise<string[]> {
  if (cachedDetection?.root === root) return cachedDetection.found
  const found: string[] = []
  const visit = async (rel: string, depth: number): Promise<void> => {
    const dir = absoluteIn(root, rel)
    if (await isUnityProject($, dir)) {
      found.push(rel)
      return
    }
    if (depth === 2) return
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.kind !== 'dir' || entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      await visit(rel === '.' ? entry.name : `${rel}/${entry.name}`, depth + 1)
    }
  }
  await visit('.', 0)
  cachedDetection = { root, found }
  return found
}

export function forgetDetection(): void {
  cachedDetection = null
  cachedConfig = null
}

export async function resolveUnityProject($: EngineInterface): Promise<UnityProject> {
  const root = toSlash(await $.session.root())
  const config = await readConfig($, root)
  if (config.unityProject) {
    const dir = absoluteIn(root, config.unityProject)
    return { root, dir, rel: relativeTo(root, dir), source: 'config', candidates: [] }
  }
  const candidates = await findUnityProjects($, root)
  const [first] = candidates
  if (candidates.length === 1 && first !== undefined) {
    return { root, dir: absoluteIn(root, first), rel: first, source: 'detected', candidates }
  }
  return { root, dir: null, rel: null, source: 'none', candidates }
}

export function describeProject(p: UnityProject): string {
  if (p.source === 'config') return `Projet Unity : ${p.rel} (réglé dans ${CONFIG_FILE}).`
  if (p.source === 'detected') return `Projet Unity : ${p.rel} (détecté automatiquement).`
  if (p.candidates.length > 1) return `Plusieurs projets Unity trouvés : ${p.candidates.join(', ')}. Choisis-en un avec /unity-project <dossier>.`
  return 'Aucun projet Unity trouvé sous ce dossier. Indique-le avec /unity-project <dossier>.'
}

// Answers /unity-project: no argument shows the project, `auto` goes back to
// detection, anything else is the Unity project's folder.
export async function unityProjectCommand($: EngineInterface, args: string): Promise<string> {
  const root = toSlash(await $.session.root())
  const wanted = args.trim().replace(/^["']|["']$/g, '')
  if (wanted === '') return describeProject(await resolveUnityProject($))
  if (wanted === 'auto') {
    await writeConfig($, root, { unityProject: undefined })
    forgetDetection()
    return `Détection automatique rétablie. ${describeProject(await resolveUnityProject($))}`
  }
  const dir = absoluteIn(root, wanted)
  if (!(await isUnityProject($, dir))) {
    return `${wanted} n'est pas un projet Unity (il faut ProjectSettings/ProjectVersion.txt et un dossier Assets non vide).`
  }
  const rel = relativeTo(root, dir)
  await writeConfig($, root, { unityProject: rel })
  forgetDetection()
  return `Projet Unity réglé sur ${rel}, enregistré dans ${CONFIG_FILE} : les mods claude-mods le suivent dès maintenant.`
}
