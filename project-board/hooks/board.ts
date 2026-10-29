import type { BoardCard } from '../types'

export const STATUS_ORDER = ['In Progress', 'Review', 'Todo', 'Sans statut'] as const
const PRIORITY_ORDER = ['Critical', 'High', 'Medium', 'Low']
const BODY_LIMIT = 4000

type RawItem = {
  id?: unknown
  title?: unknown
  status?: unknown
  priority?: unknown
  epic?: unknown
  assignees?: unknown
  milestone?: { title?: unknown } | null
  'end Date'?: unknown
  'story Points'?: unknown
  content?: { number?: unknown; url?: unknown; body?: unknown } | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)

// Reads `gh project item-list --format json`; keeps the cards assigned to `login`.
export function cardsFor(json: string, login: string): { cards: BoardCard[]; doneCount: number } {
  const items = (JSON.parse(json) as { items?: RawItem[] }).items ?? []
  const mine = items.filter(i => Array.isArray(i.assignees) && i.assignees.includes(login))
  const cards: BoardCard[] = mine.map(i => ({
    id: String(i.id ?? ''),
    number: num(i.content?.number),
    title: str(i.title) ?? '(sans titre)',
    status: str(i.status) ?? 'Sans statut',
    priority: str(i.priority),
    epic: str(i.epic),
    milestone: str(i.milestone?.title),
    endDate: str(i['end Date']),
    storyPoints: num(i['story Points']),
    url: str(i.content?.url),
    body: (str(i.content?.body) ?? '').slice(0, BODY_LIMIT),
  }))
  const rank = (p: string | null) => (p === null ? PRIORITY_ORDER.length : PRIORITY_ORDER.indexOf(p))
  return {
    cards: cards.filter(c => c.status !== 'Done').sort((a, b) => rank(a.priority) - rank(b.priority)),
    doneCount: cards.length - cards.filter(c => c.status !== 'Done').length,
  }
}

// A branch such as feat/221-port-trait points at card #221.
export function cardOfBranch(cards: readonly BoardCard[], branch: string | null): BoardCard | undefined {
  const numbers = branch?.match(/\d+/g)?.map(Number) ?? []
  return cards.find(c => c.number !== null && numbers.includes(c.number))
}

export function countsLine(cards: readonly BoardCard[]): string {
  const count = (s: string) => cards.filter(c => c.status === s).length
  return `${count('In Progress')} en cours · ${count('Review')} en review · ${count('Todo')} à faire`
}

// Reads https://github.com/orgs/<owner>/projects/<n>, the users/ form, or <owner>/<n>.
export function parseProjectRef(text: string): { owner: string; number: number } | null {
  const url = text.match(/github\.com\/(?:orgs|users)\/([A-Za-z0-9_.-]+)\/projects\/(\d+)/)
  const short = text.trim().match(/^([A-Za-z0-9_.-]+)\/(\d+)$/)
  const m = url ?? short
  return m?.[1] && m[2] ? { owner: m[1], number: Number(m[2]) } : null
}

export function promptFor(card: BoardCard, projectTitle: string): string {
  const facts = [card.status, card.priority && `priorité ${card.priority}`, card.epic && `epic ${card.epic}`]
    .filter(Boolean)
    .join(', ')
  return [
    `Je prends la carte ${projectTitle}${card.number !== null ? ` #${card.number}` : ''} « ${card.title} » (${facts}).`,
    card.url ? `Lien : ${card.url}` : '',
    '',
    "Description de l'issue :",
    card.body || '(vide)',
    '',
    'Lis le code concerné et propose-moi un plan avant de modifier quoi que ce soit.',
  ].join('\n')
}
