export type BoardCard = {
  id: string
  number: number | null
  title: string
  status: string
  priority: string | null
  epic: string | null
  milestone: string | null
  endDate: string | null
  storyPoints: number | null
  url: string | null
  body: string
}

export type BoardSnapshot = {
  state: 'unconfigured' | 'loading' | 'ready' | 'error'
  // owner/number of the GitHub project, and its title once read.
  projectRef: string | null
  projectTitle: string | null
  cards: BoardCard[]
  doneCount: number
  login: string | null
  branch: string | null
  error: string | null
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'project-board': { board: Shaped<BoardSnapshot> }
  }
}
