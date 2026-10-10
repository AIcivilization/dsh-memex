/**
 * Collect one local day of dsh activity from `ctx.sessionQuery`.
 *
 * Only the structural subset of the session-query service and of the raw
 * session events this plugin reads is declared here, so the plugin builds
 * without dsh's internal packages. Raw events (not search documents) are read
 * so that context injected by plugins (`source.kind !== 'user'`) and tool-call
 * blocks inside assistant messages stay out of the diary.
 */

export interface SessionRecordLike {
  header: { id: string; createdAt: number; cwd?: string; origin?: string; parentSession?: string }
}

export interface RawEventLike {
  seq: number
  type: string
  time: number
  data?: unknown
}

export interface ModelRoute {
  provider: string
  model: string
}

export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>
  readSession(sessionId: string): Promise<{ events: RawEventLike[] }>
  readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<Array<
    | { sessionId: string; status: 'fulfilled'; value: { title?: { title?: unknown } } }
    | { sessionId: string; status: 'rejected'; reason: unknown }
  >>
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
  /** Model route of the session's last in-day request. */
  route?: ModelRoute
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

type Block = { type?: unknown; text?: unknown }

/** Text blocks only: reasoning, tool calls and attachments are not diary material. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim()
}

/** Fold one session's in-day raw events into an activity record. */
export function foldSession(
  record: SessionRecordLike,
  events: readonly RawEventLike[],
): SessionActivity | undefined {
  if (events.length === 0) return undefined
  const activity: SessionActivity = {
    id: record.header.id,
    ...record.header.cwd !== undefined ? { cwd: record.header.cwd } : {},
    subagent: record.header.origin === 'subagent',
    firstAt: events[0]!.time,
    lastAt: events[events.length - 1]!.time,
    prompts: [],
    toolCounts: {},
    files: [],
    commands: [],
    errors: [],
    todos: [],
  }
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, any>
    switch (event.type) {
      case 'user/message': {
        // Plugin-injected context (time samples, mode banners, model-change notes) has a non-user source.
        const kind = data.source?.kind
        if (kind !== undefined && kind !== 'user') break
        const text = textOf(data.content)
        if (text !== '') activity.prompts.push(clip(text, 300))
        break
      }
      case 'assistant/message': {
        const text = textOf(data.message?.content)
        if (text !== '') activity.lastReply = clip(text, 600)
        break
      }
      case 'tool/call': {
        if (typeof data.name !== 'string' || data.name === '') break
        activity.toolCounts[data.name] = (activity.toolCounts[data.name] ?? 0) + 1
        const { files, commands } = readToolArguments(typeof data.arguments === 'string' ? data.arguments : '')
        for (const file of files) pushUnique(activity.files, file, 200)
        for (const command of commands) pushUnique(activity.commands, clip(command, 160), 100)
        break
      }
      case 'todo/write':
        if (Array.isArray(data.todos)) {
          activity.todos = (data.todos as Array<{ status?: unknown; content?: unknown }>)
            .filter(todo => typeof todo?.content === 'string')
            .map(todo => ({ status: String(todo.status ?? ''), content: clip(todo.content as string, 200) }))
        }
        break
      case 'turn/end':
        if (data.reason?.kind === 'error' && typeof data.reason.error?.message === 'string') {
          pushUnique(activity.errors, clip(data.reason.error.message, 300), 20)
        }
        break
      case 'request/header': {
        const config = data.header?.config
        if (typeof config?.provider === 'string' && typeof config.model === 'string') {
          activity.route = { provider: config.provider, model: config.model }
        }
        break
      }
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
    let events: RawEventLike[]
    try {
      events = (await query.readSession(record.header.id)).events
    } catch (error) {
      options.onSkip?.(record.header.id, error)
      continue
    }
    const activity = foldSession(record, events.filter(event => event.time >= start && event.time <= end))
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

