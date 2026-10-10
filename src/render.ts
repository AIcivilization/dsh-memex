/** Pure Markdown rendering of a day's activity, plus the digest fed to the summary model. */

import type { DayActivity, SessionActivity } from './collect.js'

function time(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function sessionName(session: SessionActivity): string {
  return session.title ?? session.prompts[0]?.slice(0, 40) ?? session.id
}

function topTools(session: SessionActivity, limit: number): string {
  return Object.entries(session.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`)
    .join(' · ')
}

function totals(day: DayActivity): { prompts: number; toolCalls: number; files: number; projects: string[] } {
  const files = new Set<string>()
  const projects = new Set<string>()
  let prompts = 0
  let toolCalls = 0
  for (const session of day.sessions) {
    prompts += session.prompts.length
    for (const count of Object.values(session.toolCounts)) toolCalls += count
    for (const file of session.files) files.add(file)
    if (session.cwd !== undefined) projects.add(session.cwd)
  }
  return { prompts, toolCalls, files: files.size, projects: [...projects] }
}

/** Render the diary file. `summary` is the optional model-written narrative. */
export function renderDiary(day: DayActivity, summary: string | undefined, generatedAt: Date): string {
  const t = totals(day)
  const lines: string[] = [
    `# Memex · ${day.date}`,
    '',
    `> ${day.sessions.length} 个会话 · ${t.prompts} 条指令 · ${t.toolCalls} 次工具调用 · ${t.files} 个文件 · 生成于 ${generatedAt.toLocaleString()}`,
    '',
  ]

  if (day.sessions.length === 0) {
    lines.push('今天 dsh 没有活动。', '')
    return lines.join('\n')
  }

  if (summary !== undefined && summary.trim() !== '') {
    lines.push('## 今日总结', '', summary.trim(), '')
  }

  if (t.projects.length > 0) {
    lines.push('## 涉及项目', '', ...t.projects.map(p => `- \`${p}\``), '')
  }

  lines.push('## 会话明细', '')
  for (const session of day.sessions) {
    lines.push(`### ${time(session.firstAt)}–${time(session.lastAt)} ${sessionName(session)}${session.subagent ? '（子代理）' : ''}`, '')
    if (session.cwd !== undefined) lines.push(`- 目录：\`${session.cwd}\``)
    lines.push(`- 会话：\`${session.id}\``)
    const tools = topTools(session, 8)
    if (tools !== '') lines.push(`- 工具：${tools}`)
    lines.push('')
    if (session.prompts.length > 0) {
      lines.push('**你说了什么**', '', ...session.prompts.map(p => `- ${p}`), '')
    }
    const done = session.todos.filter(todo => todo.status === 'completed')
    const open = session.todos.filter(todo => todo.status !== 'completed')
    if (done.length > 0 || open.length > 0) {
      lines.push('**待办**', '', ...done.map(todo => `- [x] ${todo.content}`), ...open.map(todo => `- [ ] ${todo.content}`), '')
    }
    if (session.files.length > 0) {
      lines.push('<details><summary>改动/读取的文件（' + session.files.length + '）</summary>', '', ...session.files.map(f => `- \`${f}\``), '', '</details>', '')
    }
    if (session.commands.length > 0) {
      lines.push('<details><summary>执行的命令（' + session.commands.length + '）</summary>', '', ...session.commands.map(c => `- \`${c.replace(/`/g, "'")}\``), '', '</details>', '')
    }
    if (session.errors.length > 0) {
      lines.push('**出错**', '', ...session.errors.map(e => `- ${e}`), '')
    }
    if (session.lastReply !== undefined) {
      lines.push('**最后结果**', '', `> ${session.lastReply}`, '')
    }
  }
  return lines.join('\n')
}

/** Compact text digest of the day for the summary model, capped at `maxChars`. */
export function renderDigest(day: DayActivity, maxChars: number): string {
  const parts: string[] = []
  for (const session of day.sessions) {
    const block = [
      `## ${time(session.firstAt)}-${time(session.lastAt)} ${sessionName(session)}`,
      session.cwd !== undefined ? `cwd: ${session.cwd}` : '',
      `tools: ${topTools(session, 12)}`,
      ...session.prompts.map(p => `user: ${p}`),
      ...session.todos.map(todo => `todo[${todo.status}]: ${todo.content}`),
      session.files.length > 0 ? `files: ${session.files.slice(0, 30).join(', ')}` : '',
      ...session.errors.map(e => `error: ${e}`),
      session.lastReply !== undefined ? `final: ${session.lastReply}` : '',
    ].filter(Boolean).join('\n')
    parts.push(block)
  }
  const digest = parts.join('\n\n')
  return digest.length > maxChars ? `${digest.slice(0, maxChars)}\n…(truncated)` : digest
}
