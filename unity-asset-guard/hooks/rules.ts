// Pure rules of the guard: what a path is, and what to do about a file edit or a shell command.
import { relativeTo } from './project'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; question: string; refusal: string }

export type PathClass = 'never' | 'meta' | 'yaml' | 'other'

// Unity's text-serialized assets: hand edits break fileIDs and GUID references.
const YAML = /\.(unity|prefab|asset|mat|controller|overrideController|anim|mask|playable|lighting|lightingsettings|physicMaterial|physicsMaterial2D|spriteatlas|spriteatlasv2|terrainlayer|preset|guiskin|fontsettings|flare|renderTexture|cubemap|giparams|brush|mixer|shadervariants|signal)$/i
const LFS_CONFIG = /(^|\/)\.lfsconfig$/
const GENERATED = '(Library|Temp|Logs|UserSettings|obj)(/|$)'
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Programs that change the paths they are given; for a copy, only its destination.
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'touch', 'tee', 'sed', 'perl', 'truncate', 'ln', 'chmod', 'chown', 'mkdir', 'dd', 'install'])
const COPIERS = new Set(['cp', 'rsync'])
const GIT_WRITERS = new Set(['rm', 'mv', 'add', 'checkout', 'restore', 'clean', 'reset'])

export { relativeTo }

// `unityDir` is the Unity project relative to the root ('.' for the root), or
// null when there is none: its generated folders are then not known.
export function classifyPath(rel: string, unityDir: string | null): PathClass {
  if (LFS_CONFIG.test(rel)) return 'never'
  if (unityDir !== null) {
    const generated = unityDir === '.' ? new RegExp(`^${GENERATED}`) : new RegExp(`^${escape(unityDir)}/${GENERATED}`)
    if (generated.test(rel)) return 'never'
  }
  if (/\.meta$/i.test(rel)) return 'meta'
  if (YAML.test(rel)) return 'yaml'
  return 'other'
}

const EDITOR_OPEN =
  "l'Editor Unity est ouvert sur le projet : il écraserait ou ignorerait cette modification. Fais-la dans l'Editor, ou ferme-le d'abord."

function editVerdict(rel: string, cls: PathClass, editorOpen: boolean): Verdict {
  if (cls === 'never') return { kind: 'deny', reason: `${rel} ne doit jamais être modifié par Claude (LFS ou dossier généré par Unity).` }
  if (cls === 'other') return { kind: 'allow' }
  if (editorOpen) return { kind: 'deny', reason: `${rel} : ${EDITOR_OPEN}` }
  const what = cls === 'meta' ? 'un .meta (GUID et réglages d’import)' : 'un fichier YAML Unity (scène, prefab ou asset)'
  return {
    kind: 'ask',
    question: `Claude veut modifier à la main ${what} : ${rel}. Autoriser cette modification ?`,
    refusal: `L'utilisateur a refusé la modification manuelle de ${rel}. Ne modifie pas les fichiers YAML ni les .meta Unity à la main : propose de faire le changement dans l'Editor.`,
  }
}

export function judgeEdit(input: { rel: string; unityDir: string | null; isWrite: boolean; exists: boolean; editorOpen: boolean }): Verdict {
  const cls = classifyPath(input.rel, input.unityDir)
  if (cls === 'meta' && input.isWrite && !input.exists) {
    return {
      kind: 'deny',
      reason: `ne crée pas ${input.rel} à la main : Unity génère les .meta et leur GUID à l'import. Crée seulement le fichier source.`,
    }
  }
  return editVerdict(input.rel, cls, input.editorOpen)
}

// Drops the bodies of here-documents: their lines are data written somewhere, not commands.
export function stripHeredocs(command: string): string {
  const out: string[] = []
  let end: string | null = null
  for (const line of command.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null
      continue
    }
    out.push(line)
    end = line.match(/(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)?.[2] ?? null
  }
  return out.join('\n')
}

// Splits a shell command into simple commands of words, keeping quotes together.
export function simpleCommands(command: string): string[][] {
  const commands: string[][] = [[]]
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  const push = () => {
    if (hasWord) commands.at(-1)!.push(word)
    word = ''
    hasWord = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
    } else if (c === ' ' || c === '\t') push()
    else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      push()
      if ((c === '|' || c === '&') && command[i + 1] === c) i++
      commands.push([])
    } else if (c === '>') {
      push()
      if (command[i + 1] === '>') i++
      commands.at(-1)!.push('>')
    } else {
      word += c
      hasWord = true
    }
  }
  push()
  return commands.filter(words => words.length > 0)
}

function strip(words: string[]): string[] {
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || ['sudo', 'command', 'env', 'exec'].includes(words[i]!))) i++
  return words.slice(i)
}

const isUnityAsset = (rel: string) => /(^|\/)Assets\//.test(rel)
const operands = (args: string[]) => args.filter(a => !a.startsWith('-'))

function worst(verdicts: Verdict[]): Verdict {
  const deny = verdicts.find(v => v.kind === 'deny')
  if (deny) return deny
  const asks = verdicts.filter((v): v is Extract<Verdict, { kind: 'ask' }> => v.kind === 'ask')
  if (asks.length === 0) return { kind: 'allow' }
  if (asks.length === 1) return asks[0]!
  return {
    kind: 'ask',
    question: `${asks.map(a => a.question.replace(/ \?$/, '')).join(' · ')} ?`,
    refusal: asks.map(a => a.refusal).join(' '),
  }
}

export function judgeCommand(command: string, root: string, unityDir: string | null, editorOpen: boolean): Verdict {
  const all = simpleCommands(stripHeredocs(command))
  const everyWord = new Set(all.flat().map(w => relativeTo(root, w)))
  const verdicts: Verdict[] = []

  for (const raw of all) {
    const words = strip(raw)
    const [program = '', ...args] = words
    const sub = program === 'git' ? args[0] ?? '' : ''
    const rels = words.map(w => relativeTo(root, w))

    // .lfsconfig and Unity's generated folders: a command may read them, not change them.
    const targets = WRITERS.has(program)
      ? rels.slice(1)
      : COPIERS.has(program)
        ? operands(rels.slice(1)).slice(-1)
        : program === 'git' && GIT_WRITERS.has(sub)
          ? rels.slice(2)
          : []
    const never = targets.find(r => classifyPath(r, unityDir) === 'never')
    if (never) verdicts.push({ kind: 'deny', reason: `${never} ne doit pas être modifié par Claude (LFS ou dossier généré par Unity).` })

    // Output redirected into a Unity file is a hand edit.
    const redirect = words.indexOf('>')
    if (redirect !== -1 && words[redirect + 1]) {
      const rel = relativeTo(root, words[redirect + 1]!)
      verdicts.push(editVerdict(rel, classifyPath(rel, unityDir), editorOpen))
    }

    // In-place editors: sed -i, perl -pi, tee.
    const inPlace =
      (program === 'sed' && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) ||
      (program === 'perl' && args.some(a => /^-[a-zA-Z]*i/.test(a))) ||
      program === 'tee'
    if (inPlace) {
      for (const rel of rels.slice(1)) {
        const cls = classifyPath(rel, unityDir)
        if (cls !== 'other') verdicts.push(editVerdict(rel, cls, editorOpen))
      }
    }

    // Moving or deleting an asset without its .meta loses its GUID.
    const isRemove = program === 'rm' || (program === 'git' && sub === 'rm')
    const isMove = program === 'mv' || (program === 'git' && sub === 'mv')
    if (isRemove || isMove) {
      const targets = operands(program === 'git' ? args.slice(1) : args).map(a => relativeTo(root, a))
      const sources = isMove ? targets.slice(0, -1) : targets
      for (const source of sources) {
        if (!isUnityAsset(source) || /[*?]/.test(source)) continue
        if (source.endsWith('.meta')) {
          if (!everyWord.has(source.slice(0, -'.meta'.length))) {
            verdicts.push({
              kind: 'ask',
              question: `Claude veut ${isMove ? 'déplacer' : 'supprimer'} ${source} sans son asset. Continuer ?`,
              refusal: `L'utilisateur a refusé de toucher ${source} seul. Un .meta va toujours avec son asset.`,
            })
          }
          continue
        }
        if (!everyWord.has(`${source}.meta`)) {
          verdicts.push({
            kind: 'deny',
            reason: `${isMove ? 'déplace' : 'supprime'} aussi ${source}.meta dans la même commande (ex. git mv A.cs B.cs && git mv A.cs.meta B.cs.meta), sinon Unity perd le GUID et les références vers ce fichier cassent.`,
          })
        } else if (isRemove && classifyPath(source, unityDir) === 'yaml') {
          verdicts.push({
            kind: 'ask',
            question: `Claude veut supprimer ${source}. Supprimer ce fichier Unity ?`,
            refusal: `L'utilisateur a refusé la suppression de ${source}.`,
          })
        }
      }
    }

    // Git commands that throw away uncommitted work, scenes and prefabs included.
    if (program === 'git') {
      const rest = args.slice(1)
      const discards =
        (sub === 'reset' && rest.includes('--hard')) ||
        (sub === 'clean' && rest.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')) ||
        (sub === 'checkout' && (rest.includes('--') || rest.includes('.'))) ||
        (sub === 'restore' && (!rest.includes('--staged') || rest.includes('--worktree'))) ||
        (sub === 'stash' && ['drop', 'clear'].includes(rest[0] ?? ''))
      if (discards) {
        verdicts.push({
          kind: 'ask',
          question: `« ${raw.join(' ')} » jette des modifications non commitées, scènes et prefabs compris. Lancer cette commande ?`,
          refusal: `L'utilisateur a refusé « ${raw.join(' ')} ». Ne jette pas de modifications non commitées sans le lui demander.`,
        })
      }
    }
  }
  return worst(verdicts)
}
