/**
 * dsh-memex — a daily work diary for DeepSeek Harness.
 *
 * Every day at `writeAt` it reads the day's sessions through
 * `ctx.sessionQuery` (live and persisted, the same history the model saw),
 * folds them into prompts / tools / files / commands / todos / errors per
 * session, optionally asks the model for a short narrative, and writes
 * `<outputDir>/YYYY-MM-DD.md`. On startup it back-fills recent days whose
 * diary is missing or was written before the day ended. `/memex` writes on
 * demand.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { collectDay, dayBounds, type SessionQueryLike } from './collect.js'
import { Config, type MemexConfig } from './config.js'
import { renderDiary, renderDigest } from './render.js'
import { summarizeDay, type LlmLike } from './summarize.js'

export const name = 'dsh-memex'

export const usage = `Writes a daily Markdown diary of what dsh did: sessions, prompts, tools, files, commands, todos and errors, with an optional model-written summary. /memex writes today's diary on demand.`

export const inject = ['sessionQuery']

export { Config }
export type { MemexConfig }

const DAY_MS = 24 * 60 * 60 * 1000

interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { rawInput: string }) => Promise<{ kind: 'success' | 'error'; text: string }>
  }): () => void
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/** ms from `now` until the next local `HH:MM`. */
export function msUntil(writeAt: string, now: Date): number {
  const [h, m] = writeAt.split(':').map(Number) as [number, number]
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

/** Resolve `/memex` input: empty = today, `yesterday`/`昨天`, `-N`, or `YYYY-MM-DD`. */
export function parseDayInput(raw: string, now: Date): Date | undefined {
  const input = raw.trim()
  if (input === '' || input === 'today' || input === '今天') return now
  if (input === 'yesterday' || input === '昨天') return new Date(now.getTime() - DAY_MS)
  if (/^-\d+$/.test(input)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(input), 12)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (match === null) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
}

export function apply(ctx: Context, config: MemexConfig): void {
  const query = (ctx as unknown as { sessionQuery: SessionQueryLike }).sessionQuery
  const outputDir = expandHome(config.outputDir)
  let llm: LlmLike | undefined

  ctx.inject(['llm'], (llmCtx) => {
    llmCtx.effect(() => {
      llm = (llmCtx as unknown as { llm: LlmLike }).llm
      return () => { llm = undefined }
    })
  })

  /** Model summary, or the reason it is missing so the diary itself shows why. */
  async function summary(day: Awaited<ReturnType<typeof collectDay>>): Promise<{ text?: string; note?: string }> {
    if (!config.summarize || day.sessions.length === 0) return {}
    if (llm === undefined) return { note: 'dsh 的 LLM 服务不可用' }
    const configured = config.provider !== undefined && config.model !== undefined
      ? { provider: config.provider, model: config.model }
      : undefined
    const route = configured ?? [...day.sessions].sort((a, b) => b.lastAt - a.lastAt).find(s => s.route !== undefined)?.route
    if (route === undefined) return { note: '找不到可用的模型，请在配置里设置 provider 和 model' }
    try {
      return {
        text: await summarizeDay(llm, {
          ...route,
          language: config.language,
          date: day.date,
          digest: renderDigest(day, config.maxSummaryInputChars),
          maxTokens: config.maxSummaryOutputTokens,
        }),
      }
    } catch (error) {
      ctx.logger.warn(`dsh-memex: summary failed, writing factual log only (${(error as Error).message})`)
      return { note: `${route.provider}/${route.model}：${(error as Error).message}` }
    }
  }

  /** Write the diary for the day containing `at`; `skipEmpty` leaves days without activity unwritten. */
  async function writeDay(at: Date, skipEmpty = false): Promise<{ path: string; sessions: number } | undefined> {
    const day = await collectDay(query, at, {
      scanWindowDays: config.scanWindowDays,
      includeSubagents: config.includeSubagents,
      onSkip: (id, error) => ctx.logger.warn(`dsh-memex: skipped session ${id} (${(error as Error).message})`),
    })
    if (skipEmpty && day.sessions.length === 0) return undefined
    const { text, note } = await summary(day)
    const markdown = renderDiary(day, text, new Date(), note)
    await mkdir(outputDir, { recursive: true })
    const path = join(outputDir, `${day.date}.md`)
    await writeFile(path, markdown, 'utf8')
    ctx.logger.info(`dsh-memex: wrote ${path} (${day.sessions.length} sessions)`)
    return { path, sessions: day.sessions.length }
  }

  /** Re-write past days whose diary is missing or predates the end of that day. */
  async function catchUp(): Promise<void> {
    const now = new Date()
    for (let back = config.catchUpDays; back >= 1; back--) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12)
      const { date, end } = dayBounds(at)
      const existing = await stat(join(outputDir, `${date}.md`)).catch(() => undefined)
      if (existing !== undefined && existing.mtimeMs > end) continue
      await writeDay(at, true)
    }
  }

  ctx.effect(() => {
    let timer: NodeJS.Timeout | undefined
    let disposed = false
    const schedule = () => {
      timer = setTimeout(() => {
        writeDay(new Date())
          .catch(error => ctx.logger.warn(`dsh-memex: daily write failed (${(error as Error).message})`))
          .finally(() => { if (!disposed) schedule() })
      }, msUntil(config.writeAt, new Date()))
    }
    schedule()
    catchUp().catch(error => ctx.logger.warn(`dsh-memex: catch-up failed (${(error as Error).message})`))
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  })

  ctx.inject(['commands'], (commandCtx) => {
    const commands = (commandCtx as unknown as { commands: CommandsLike }).commands
    commandCtx.effect(() => commands.register({
      name: 'memex',
      description: 'write the dsh diary for today (or yesterday / -N / YYYY-MM-DD)',
      input: { hint: '[today|yesterday|-N|YYYY-MM-DD]' },
      async handler(invocation) {
        const at = parseDayInput(invocation.rawInput, new Date())
        if (at === undefined) return { kind: 'error', text: 'Usage: /memex [today|yesterday|-N|YYYY-MM-DD]' }
        const { path, sessions } = (await writeDay(at))!
        return { kind: 'success', text: `日记已写入 ${path}（${sessions} 个会话）` }
      },
    }))
  })

  ctx.logger.info(`dsh-memex armed (writeAt=${config.writeAt}, dir=${outputDir})`)
}
