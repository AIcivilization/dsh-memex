/**
 * One auxiliary model call turning the day's digest into a short narrative.
 *
 * Talks to `ctx.llm.stream()` through a structural subset (the
 * `@deepseek-ai/dsh-llm` types are not a dependency of this plugin) and
 * mirrors dsh's session-title call: one user message, text-only output,
 * `text-delta` chunks concatenated, any non-`stop` finish is a failure.
 */

import { randomUUID } from 'node:crypto'

export interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<{ type: string; text?: string; reason?: { kind?: string; failure?: { message?: string } } }>
}

export interface SummaryRequest {
  provider: string
  model: string
  language: string
  date: string
  digest: string
  signal?: AbortSignal
}

function systemPrompt(language: string): string {
  return [
    'You write a personal work diary from the activity log of an AI coding agent (dsh) for one day.',
    `Write in ${language}. Use Markdown with no top-level heading.`,
    'Start with 2-4 sentences on what was accomplished overall, then a bullet list of concrete outcomes grouped by project,',
    'then a short "遗留问题 / 明天可以继续" list for unfinished todos or errors. Be factual; do not invent work that is not in the log.',
  ].join('\n')
}

export async function summarizeDay(llm: LlmLike, request: SummaryRequest): Promise<string> {
  const message = {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'plugin', plugin: 'dsh-memex' },
    content: [{ type: 'text', text: `Activity log for ${request.date}:\n\n${request.digest}` }],
  }
  let text = ''
  for await (const chunk of llm.stream({
    provider: request.provider,
    model: request.model,
    system: systemPrompt(request.language),
    messages: [message],
    maxTokens: 2000,
    ...request.signal !== undefined ? { signal: request.signal } : {},
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') {
      throw new Error(`dsh-memex: summary finished with ${chunk.reason?.kind ?? 'unknown'}${chunk.reason?.failure?.message !== undefined ? `: ${chunk.reason.failure.message}` : ''}`)
    }
  }
  if (text.trim() === '') throw new Error('dsh-memex: summary model produced no text')
  return text.trim()
}
