/**
 * Collect one local day of dsh activity from `ctx.sessionQuery`.
 *
 * Only the structural subset of the session-query service this plugin reads
 * is declared here, so the plugin builds without dsh's internal packages.
 * Event documents carry first-party semantic text (see dsh
 * `session-query/src/extraction.ts`): user/assistant text, `tool/call` as
 * `name\narguments`, `todo/write` as `status\ncontent` pairs, `turn/end` as
 * `error\nmessage` for failed turns.
 */

export interface SessionRecordLike {
  header: { id: string; createdAt: number; cwd?: string; origin?: string; parentSession?: string }
}

export interface EventDocLike {
  seq: number
  type: string
  time: number
  text: string
}

export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>
  filterEvents(sessionId: string, filters: readonly unknown[]): Promise<EventDocLike[]>
  readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<Array<
    | { sessionId: string; status: 'fulfilled'; value: { title?: { title?: unknown } } }
    | { sessionId: string; status: 'rejected'; reason: unknown }
  >>
  listEvents(sessionId: string): Promise<Array<{ seq: number; type: string; time: number }>>
  readEvent(request: { sessionId: string; seq: number; before?: number; after?: number }): Promise<{ target: { data?: unknown } }>
}

export interface TodoItem {
  status: string
  content: string
}

export interface SessionActivity {
  id: string
  title?: string
  cwd?: string
  subagent: boolean
  firstAt: number
  lastAt: number
  prompts: string[]
  /** Last assistant text of the day in this session. */
  lastReply?: string
  toolCounts: Record<string, number>
  files: string[]
  commands: string[]
  errors: string[]
  todos: TodoItem[]
}

export interface DayActivity {
  /** Local date, YYYY-MM-DD. */
  date: string
  start: number
  end: number
  sessions: SessionActivity[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const FILE_KEYS = ['path', 'file_path', 'filePath', 'file', 'target', 'notebook_path']
const COMMAND_KEYS = ['command', 'cmd', 'script']

/** Local midnight-to-midnight bounds of the day containing `at`. */
export function dayBounds(at: Date): { date: string; start: number; end: number } {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1)
  return { date: localDate(start), start: start.getTime(), end: next.getTime() - 1 }
}

export function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function pushUnique(list: string[], value: string, max: number): void {
  if (value !== '' && !list.includes(value) && list.length < max) list.push(value)
}

/** Pull file paths and shell commands out of one tool call's JSON arguments. */
export function readToolArguments(raw: string): { files: string[]; commands: string[] } {
  const files: string[] = []
  const commands: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Truncated or non-JSON arguments: nothing structured to extract.
    return { files, commands }
  }
  if (parsed === null || typeof parsed !== 'object') return { files, commands }
  const args = parsed as Record<string, unknown>
  for (const key of FILE_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') files.push(value.trim())
  }
  if (Array.isArray(args.paths)) {
    for (const value of args.paths) if (typeof value === 'string') files.push(value)
  }
  for (const key of COMMAND_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') commands.push(value.trim())
  }
  return { files, commands }
}

/** Fold one session's in-day event documents into an activity record. */
export function foldSession(
  record: SessionRecordLike,
  docs: readonly EventDocLike[],
): SessionActivity | undefined {
  if (docs.length === 0) return undefined
  const activity: SessionActivity = {
    id: record.header.id,
    ...record.header.cwd !== undefined ? { cwd: record.header.cwd } : {},
    subagent: record.header.origin === 'subagent',
    firstAt: docs[0]!.time,
    lastAt: docs[docs.length - 1]!.time,
    prompts: [],
    toolCounts: {},
    files: [],
    commands: [],
    errors: [],
    todos: [],
  }
  for (const doc of docs) {
    switch (doc.type) {
      case 'user/message':
        if (doc.text !== '') activity.prompts.push(clip(doc.text, 300))
        break
      case 'assistant/message':
        if (doc.text !== '') activity.lastReply = clip(doc.text, 600)
        break
      case 'tool/call': {
        const newline = doc.text.indexOf('\n')
        const name = newline === -1 ? doc.text : doc.text.slice(0, newline)
        if (name === '') break
        activity.toolCounts[name] = (activity.toolCounts[name] ?? 0) + 1
        const { files, commands } = readToolArguments(newline === -1 ? '' : doc.text.slice(newline + 1))
        for (const file of files) pushUnique(activity.files, file, 200)
        for (const command of commands) pushUnique(activity.commands, clip(command, 160), 100)
        break
      }
      case 'todo/write': {
        const lines = doc.text.split('\n')
        const todos: TodoItem[] = []
        for (let i = 0; i + 1 < lines.length; i += 2) {
          todos.push({ status: lines[i]!, content: clip(lines[i + 1]!, 200) })
        }
        activity.todos = todos
        break
      }
      case 'turn/end':
        if (doc.text.startsWith('error')) pushUnique(activity.errors, clip(doc.text.slice(5), 300), 20)
        break
      default:
        break
    }
  }
  if (activity.prompts.length === 0 && Object.keys(activity.toolCounts).length === 0 && activity.lastReply === undefined) {
    return undefined
  }
  return activity
}

/**
 * Gather every session with activity inside the local day containing `at`.
 * Per-session read failures are skipped so one corrupt log never blocks a diary.
 */
export async function collectDay(
  query: SessionQueryLike,
  at: Date,
  options: { scanWindowDays: number; includeSubagents: boolean; onSkip?: (id: string, error: unknown) => void },
): Promise<DayActivity> {
  const { date, start, end } = dayBounds(at)
  const oldest = start - options.scanWindowDays * DAY_MS
  const records = (await query.listSessions()).filter(record =>
    record.header.createdAt <= end
    && record.header.createdAt >= oldest
    && (options.includeSubagents || record.header.origin !== 'subagent'))

  const sessions: SessionActivity[] = []
  for (const record of records) {
    let docs: EventDocLike[]
    try {
      docs = await query.filterEvents(record.header.id, [{ kind: 'time', from: start, to: end }])
    } catch (error) {
      options.onSkip?.(record.header.id, error)
      continue
    }
    const activity = foldSession(record, docs)
    if (activity !== undefined) sessions.push(activity)
  }

  if (sessions.length > 0) {
    const titles = await query.readTitleSnapshots(sessions.map(s => s.id)).catch(() => [])
    for (const result of titles) {
      if (result.status !== 'fulfilled') continue
      const title = result.value.title?.title
      const session = sessions.find(s => s.id === result.sessionId)
      if (session !== undefined && typeof title === 'string' && title.trim() !== '') session.title = title.trim()
    }
  }

  sessions.sort((a, b) => a.firstAt - b.firstAt)
  return { date, start, end, sessions }
}

/**
 * Model route (`provider` + `model`) of the last request `sessionId` sent,
 * read from its latest `request/header` event.
 */
export async function latestRoute(
  query: SessionQueryLike,
  sessionId: string,
): Promise<{ provider: string; model: string } | undefined> {
  const records = await query.listEvents(sessionId)
  const header = [...records].reverse().find(record => record.type === 'request/header')
  if (header === undefined) return undefined
  const { target } = await query.readEvent({ sessionId, seq: header.seq, before: 0, after: 0 })
  const config = (target.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined)?.header?.config
  if (typeof config?.provider !== 'string' || typeof config.model !== 'string') return undefined
  return { provider: config.provider, model: config.model }
}
