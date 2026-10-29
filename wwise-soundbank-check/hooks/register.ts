import type { EngineInterface, Register } from 'claude-code'

import { absoluteIn, modsHelpCommand, registerModsHelp, relativeTo, resolveUnityProject } from './project'

const CHECK_EVERY_MS = 60_000
// A bank generated within a minute of the last source edit counts as up to date.
const SLACK_MS = 60_000
// Folders of a Wwise project that hold no authoring source to compare with.
const SKIP = new Set(['GeneratedSoundBanks', 'Originals', '.cache', 'Backups', 'Cache'])

export type WwiseCheck = {
  state: 'no-wwise' | 'missing' | 'stale' | 'ok'
  banks: number
  newestBank: number
  newestSource: number
  banksDir: string
  projectFile: string
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() || undefined

type Found = { count: number; newest: number }

async function walk($: EngineInterface, dir: string, depth: number, keep: (name: string) => boolean): Promise<Found> {
  const found: Found = { count: 0, newest: 0 }
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.kind === 'file' && keep(entry.name)) {
      found.count += 1
      found.newest = Math.max(found.newest, entry.mtimeMs)
    } else if (entry.kind === 'dir' && depth > 0 && !SKIP.has(entry.name)) {
      const below = await walk($, `${dir}/${entry.name}`, depth - 1, keep)
      found.count += below.count
      found.newest = Math.max(found.newest, below.newest)
    }
  }
  return found
}

export async function inspect($: EngineInterface): Promise<WwiseCheck & { root: string }> {
  const project = await resolveUnityProject($)
  const none = { state: 'no-wwise' as const, banks: 0, newestBank: 0, newestSource: 0, banksDir: '', projectFile: '', root: project.root }
  if (project.dir === null) return none
  const settingsPath = `${project.dir}/Assets/WwiseSettings.xml`
  if (!(await $.fs.exists(settingsPath))) return none
  const xml = await $.fs.read(settingsPath)
  // Both paths in WwiseSettings.xml are relative to Assets/.
  const assets = `${project.dir}/Assets`
  const banksDir = absoluteIn(assets, tag(xml, 'RootOutputPath') ?? 'StreamingAssets/Audio/GeneratedSoundBanks')
  const projectFile = absoluteIn(assets, tag(xml, 'WwiseProjectPath') ?? '')
  const projectDir = projectFile.replace(/\/[^/]+$/, '')

  // Banks sit in one folder per platform (Mac/, Windows/, Linux/).
  const banks = await walk($, banksDir, 2, name => name.endsWith('.bnk'))
  const sources = await walk($, projectDir, 3, name => name.endsWith('.wwu') || name.endsWith('.wproj'))
  const state = banks.count === 0 ? 'missing' : sources.newest > banks.newest + SLACK_MS ? 'stale' : 'ok'
  return { state, banks: banks.count, newestBank: banks.newest, newestSource: sources.newest, banksDir, projectFile, root: project.root }
}

function statusFor(check: WwiseCheck): string | undefined {
  if (check.state === 'missing') return '🔇 SoundBanks Wwise absentes : le jeu sera muet · /wwise'
  if (check.state === 'stale') return 'SoundBanks Wwise plus anciennes que le projet Wwise · /wwise'
  return undefined
}

function report(check: WwiseCheck & { root: string }): string {
  const banksDir = relativeTo(check.root, check.banksDir)
  const projectFile = relativeTo(check.root, check.projectFile)
  const generate = `Génère-les : ouvre ${projectFile} dans Wwise Authoring, puis Project > Generate SoundBanks.`
  switch (check.state) {
    case 'no-wwise':
      return "Pas de projet Wwise ici (aucun Assets/WwiseSettings.xml dans le projet Unity suivi)."
    case 'missing':
      return `Aucune SoundBank (.bnk) dans ${banksDir} : le jeu n'aura pas de son. ${generate}`
    case 'stale':
      return `Le projet Wwise a été modifié après la dernière génération des ${check.banks} SoundBanks de ${banksDir}. ${generate}`
    case 'ok':
      return `✓ ${check.banks} SoundBanks à jour dans ${banksDir}.`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const check = async () => $.ui.status(statusFor(await inspect($)))
    void check().catch(() => undefined)
    $.clock.every(CHECK_EVERY_MS, check)
    await $.command.register({ name: 'wwise', description: 'Vérifie que les SoundBanks Wwise du projet sont générées et à jour', immediate: true })
    await registerModsHelp($)
    return started
  })

  on('command.run', { command: 'claude-mods' }, async $ => ({ text: await modsHelpCommand($) }))

  on('command.run', { command: 'wwise' }, async $ => {
    const check = await inspect($)
    $.ui.status(statusFor(check))
    return { text: report(check) }
  })
}
