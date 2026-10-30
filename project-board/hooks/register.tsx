import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BoardCard, BoardSnapshot } from '../types'
import { STATE_QUERY, STATUS_ORDER, cardOfBranch, cardsFor, closedItems, countsLine, parseProjectRef, promptFor } from './board'
import { CONFIG_FILE, modsHelpCommand, readConfig, registerModsHelp, toSlash, writeConfig } from './project'

const PANE = 'project-board'
const REFRESH_EVERY_MS = 5 * 60_000

const EMPTY: BoardSnapshot = {
  state: 'loading',
  projectRef: null,
  projectTitle: null,
  cards: [],
  doneCount: 0,
  login: null,
  branch: null,
  error: null,
  fetchedAt: 0,
}
const board = atom({ plugin: 'project-board', key: 'board' } as const, EMPTY, { shape: 'board-2' })

let login: string | null = null
let isRefreshing = false
const titles = new Map<string, string>()

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? ''
}

async function gh($: EngineInterface, args: string[], what: string): Promise<string> {
  const run = await $.process.run(['gh', ...args], { timeoutMs: 60_000 })
  if (run.exitCode !== 0) throw new Error(`gh ${what} : ${firstLine(run.stderr)}`)
  return run.stdout
}

// The cards archived, or whose issue or pull request is closed, by id; a hundred ids per query.
async function closedCards($: EngineInterface, ids: readonly string[]): Promise<Set<string>> {
  const closed = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const vars = ids.slice(i, i + 100).flatMap(id => ['-f', `ids[]=${id}`])
    for (const id of closedItems(await gh($, ['api', 'graphql', '-f', `query=${STATE_QUERY}`, ...vars], 'api graphql'))) closed.add(id)
  }
  return closed
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const root = toSlash(await $.session.root())
    const { github } = await readConfig($, root)
    if (!github) {
      await update($, board, () => ({ ...EMPTY, state: 'unconfigured' as const }))
      $.ui.status(undefined)
      return
    }
    const ref = `${github.owner}/${github.number}`
    const number = String(github.number)
    if (login === null) login = (await gh($, ['api', 'user', '--jq', '.login'], 'api user')).trim()
    if (!titles.has(ref)) {
      const view = JSON.parse(await gh($, ['project', 'view', number, '--owner', github.owner, '--format', 'json'], 'project view')) as { title?: string }
      titles.set(ref, view.title ?? ref)
    }
    const items = await gh($, ['project', 'item-list', number, '--owner', github.owner, '--format', 'json', '--limit', '500'], 'project item-list')
    const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd: root })
    const mine = cardsFor(items, login)
    const closed = await closedCards($, mine.cards.map(c => c.id))
    const cards = mine.cards.filter(c => !closed.has(c.id))
    const doneCount = mine.doneCount + mine.cards.length - cards.length
    const snapshot: BoardSnapshot = {
      state: 'ready',
      projectRef: ref,
      projectTitle: titles.get(ref) ?? ref,
      cards,
      doneCount,
      login,
      branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
      error: null,
      fetchedAt: await $.clock.now(),
    }
    await update($, board, () => snapshot)
    $.ui.status(`${snapshot.projectTitle} : ${countsLine(cards)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, board, b => ({ ...(b ?? EMPTY), state: 'error' as const, error: message }))
    $.ui.status('Projet GitHub illisible · /board')
  } finally {
    isRefreshing = false
  }
}

// Answers /board-project: no argument shows the project, `none` forgets it.
async function boardProjectCommand($: EngineInterface, args: string): Promise<string> {
  const root = toSlash(await $.session.root())
  const wanted = args.trim()
  if (wanted === '') {
    const { github } = await readConfig($, root)
    return github
      ? `Projet GitHub suivi : ${github.owner}/${github.number} (réglé dans ${CONFIG_FILE}).`
      : 'Aucun projet GitHub réglé. Donne son lien : /board-project https://github.com/orgs/<owner>/projects/<n>'
  }
  if (wanted === 'none') {
    await writeConfig($, root, { github: undefined })
    return `Projet GitHub oublié (${CONFIG_FILE}).`
  }
  const ref = parseProjectRef(wanted)
  if (ref === null) return `« ${wanted} » n'est pas un projet GitHub : donne son lien (…/orgs/<owner>/projects/<n>) ou <owner>/<n>.`
  await writeConfig($, root, { github: ref })
  return `Projet GitHub réglé sur ${ref.owner}/${ref.number}, enregistré dans ${CONFIG_FILE}.`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function cut(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void refresh($)
    $.clock.every(REFRESH_EVERY_MS, () => refresh($))
    await $.command.register({ name: 'board', description: 'Ouvre tes cartes du projet GitHub suivi et les recharge', immediate: true })
    await $.command.register({
      name: 'board-project',
      description: 'Affiche ou règle le projet GitHub suivi (lien ou owner/numéro)',
      argumentHint: '[lien | owner/numéro | none]',
      immediate: true,
    })
    await registerModsHelp($)
    return started
  })

  on('command.run', { command: 'claude-mods' }, async $ => ({ text: await modsHelpCommand($) }))

  on('command.run', { command: 'board' }, async $ => {
    void refresh($)
    await $.ui.open({ id: PANE, title: 'Projet GitHub' })
    return {}
  })

  on('command.run', { command: 'board-project' }, async ($, e) => {
    const text = await boardProjectCommand($, e.args)
    await refresh($)
    return { text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const b = await read($, board)
    const width = Math.max(20, e.props.bodyColumns ?? 40)
    const current = cardOfBranch(b.cards, b.branch)
    const title = b.projectTitle ?? b.projectRef ?? 'Projet GitHub'

    const cardRow = (card: BoardCard) => (
      <Box flexDirection="column">
        <Text color={card.id === current?.id ? 'suggestion' : undefined} weight={card.id === current?.id ? 'semibold' : undefined}>
          {cut(`${card.id === current?.id ? '▶ ' : ''}${card.number !== null ? `#${card.number} ` : ''}${card.title}`, width)}
        </Text>
        <Box flexDirection="row" gap={1}>
          {card.endDate !== null && <Text dimColor>{`→ ${card.endDate}`}</Text>}
          <Button
            key={`work-${card.id}`}
            label="Travailler dessus"
            onPress={() => void $.prompt.submit({ text: promptFor(card, title) }).catch(() => $.ui.toast("Impossible d'envoyer la carte à Claude"))}
          />
          {card.url !== null && <Link href={card.url} label="GitHub" />}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text weight="semibold">
            {title}
            {b.login ? ` · ${b.login}` : ''}
          </Text>
          <Button key="refresh" label="Rafraîchir" onPress={() => void refresh($)} />
        </Box>
        {b.state === 'unconfigured' && (
          <Text>{'Aucun projet GitHub réglé. Tape /board-project suivi du lien du projet (https://github.com/orgs/<owner>/projects/<n>).'}</Text>
        )}
        {b.state === 'loading' && <Text dimColor>Chargement du projet…</Text>}
        {b.state === 'error' && <Text color="error">{b.error}</Text>}
        {b.state === 'error' && <Text dimColor>Vérifie `gh auth status` : le compte actif doit voir le projet {b.projectRef ?? ''} (droit read:project).</Text>}
        {b.fetchedAt > 0 && (
          <Text dimColor>
            {countsLine(b.cards)} · {b.doneCount} terminée(s) · branche {b.branch ?? '?'} · màj {clock(b.fetchedAt)}
          </Text>
        )}
        {STATUS_ORDER.map(status => {
          const cards = b.cards.filter(c => c.status === status)
          if (cards.length === 0) return null
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text weight="semibold">
                {status} ({cards.length})
              </Text>
              {cards.map(cardRow)}
            </Box>
          )
        })}
        {b.state === 'ready' && b.cards.length === 0 && <Text dimColor>Aucune carte ouverte ne t'est assignée.</Text>}
      </Box>
    )
  })
}
