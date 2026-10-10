import Schema from '@deepseek-ai/schemastery'

export interface MemexConfig {
  /** Directory receiving one `YYYY-MM-DD.md` per day. `~` expands to the home directory. */
  outputDir: string
  /** Local time (HH:MM) at which today's diary is written. */
  writeAt: string
  /** On startup, back-fill missing diaries for this many past days. */
  catchUpDays: number
  /** Only scan sessions created within this many days before the target day. */
  scanWindowDays: number
  /** Include subagent child sessions as their own entries. */
  includeSubagents: boolean
  /** Ask the model for a narrative summary on top of the factual log. */
  summarize: boolean
  /** Model route for the summary; both or neither. Default: the route the day's last session used. */
  provider?: string
  model?: string
  /** Character budget of the activity digest sent to the model. */
  maxSummaryInputChars: number
  /** Language the summary is written in. */
  language: string
}

export const Config: Schema<MemexConfig> = Schema.object({
  outputDir: Schema.string().default('~/.dsh/memex').description('Memex diary directory'),
  writeAt: Schema.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('23:30').description('Daily write time (HH:MM, local)'),
  catchUpDays: Schema.natural().default(3).description('Back-fill missing diaries for this many past days on startup'),
  scanWindowDays: Schema.natural().default(30).description('Only scan sessions created within this many days'),
  includeSubagents: Schema.boolean().default(false).description('List subagent sessions separately'),
  summarize: Schema.boolean().default(true).description('Add an LLM-written summary'),
  provider: Schema.string().description('LLM provider route for the summary'),
  model: Schema.string().description('LLM model id for the summary'),
  maxSummaryInputChars: Schema.natural().default(24000).description('Digest size sent to the model'),
  language: Schema.string().default('中文').description('Summary language'),
}) as Schema<MemexConfig>
