import { describe, expect, it } from 'vitest'
import { collectDay, dayBounds, readToolArguments, type SessionQueryLike } from '../src/collect.ts'
import { msUntil, parseDayInput } from '../src/index.ts'
import { renderDiary, renderDigest } from '../src/render.ts'

const day = new Date(2026, 9, 10, 15)
const { start } = dayBounds(day)
const at = (h: number, m = 0) => start + (h * 60 + m) * 60_000

function fakeQuery(): SessionQueryLike {
  const sessions = [
    { header: { id: 's-old', createdAt: at(-200 * 24) } },
    { header: { id: 's-a', createdAt: at(9), cwd: '/Users/wf/dsh/dsh-vps' } },
    { header: { id: 's-sub', createdAt: at(10), origin: 'subagent' } },
    { header: { id: 's-yesterday', createdAt: at(-20) } },
  ]
  const events: Record<string, Array<{ seq: number; type: string; time: number; text: string }>> = {
    's-a': [
      { seq: 1, type: 'user/message', time: at(9, 5), text: '修复 vps 安装脚本' },
      { seq: 2, type: 'tool/call', time: at(9, 6), text: 'read\n{"path":"install.sh"}' },
      { seq: 3, type: 'tool/call', time: at(9, 7), text: 'bash\n{"command":"bash install.sh --dry-run"}' },
      { seq: 4, type: 'tool/call', time: at(9, 8), text: 'edit\n{"file_path":"install.sh"}' },
      { seq: 5, type: 'todo/write', time: at(9, 9), text: 'completed\n修复权限\npending\n补测试' },
      { seq: 6, type: 'turn/end', time: at(9, 10), text: 'error\nrate limited' },
      { seq: 7, type: 'assistant/message', time: at(9, 20), text: '已修复安装脚本。' },
    ],
    's-yesterday': [
      { seq: 1, type: 'user/message', time: at(-5), text: 'old' },
    ],
  }
  return {
    async listSessions() { return sessions },
    async filterEvents(id, filters) {
      const range = filters[0] as { from: number; to: number }
      return (events[id] ?? []).filter(e => e.time >= range.from && e.time <= range.to)
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => ({ sessionId: id, status: 'fulfilled' as const, value: { title: { title: 'VPS 安装修复' } } }))
    },
    async listEvents() { return [] },
    async readEvent() { return { target: {} } },
  }
}

describe('collectDay', () => {
  it('keeps only sessions with in-day activity and folds their events', async () => {
    const result = await collectDay(fakeQuery(), day, { scanWindowDays: 30, includeSubagents: false })
    expect(result.date).toBe('2026-10-10')
    expect(result.sessions.map(s => s.id)).toEqual(['s-a'])
    const [s] = result.sessions
    expect(s!.title).toBe('VPS 安装修复')
    expect(s!.toolCounts).toEqual({ read: 1, bash: 1, edit: 1 })
    expect(s!.files).toEqual(['install.sh'])
    expect(s!.commands).toEqual(['bash install.sh --dry-run'])
    expect(s!.todos).toEqual([{ status: 'completed', content: '修复权限' }, { status: 'pending', content: '补测试' }])
    expect(s!.errors).toEqual(['rate limited'])
    expect(s!.lastReply).toBe('已修复安装脚本。')
  })

  it('skips sessions whose reads fail', async () => {
    const query = fakeQuery()
    query.filterEvents = async () => { throw new Error('corrupt') }
    const skipped: string[] = []
    const result = await collectDay(query, day, { scanWindowDays: 30, includeSubagents: false, onSkip: id => skipped.push(id) })
    expect(result.sessions).toEqual([])
    expect(skipped).toEqual(['s-a', 's-yesterday'])
  })
})

describe('render', () => {
  it('renders summary, sessions, todos and an empty-day message', async () => {
    const result = await collectDay(fakeQuery(), day, { scanWindowDays: 30, includeSubagents: false })
    const md = renderDiary(result, '今天修好了安装脚本。', day)
    expect(md).toContain('# Memex · 2026-10-10')
    expect(md).toContain('## 今日总结')
    expect(md).toContain('- [x] 修复权限')
    expect(md).toContain('- [ ] 补测试')
    expect(md).toContain('`/Users/wf/dsh/dsh-vps`')
    expect(renderDiary({ ...result, sessions: [] }, undefined, day)).toContain('今天 dsh 没有活动')
    expect(renderDigest(result, 40)).toMatch(/…\(truncated\)$/)
  })
})

describe('helpers', () => {
  it('extracts files and commands from tool arguments', () => {
    expect(readToolArguments('{"paths":["a","b"],"cmd":"ls"}')).toEqual({ files: ['a', 'b'], commands: ['ls'] })
    expect(readToolArguments('not json')).toEqual({ files: [], commands: [] })
  })

  it('schedules the next write time', () => {
    expect(msUntil('23:30', new Date(2026, 9, 10, 23, 0))).toBe(30 * 60_000)
    expect(msUntil('08:00', new Date(2026, 9, 10, 9, 0))).toBe(23 * 60 * 60_000)
  })

  it('parses /memex input', () => {
    const now = new Date(2026, 9, 10, 15)
    expect(dayBounds(parseDayInput('昨天', now)!).date).toBe('2026-10-09')
    expect(dayBounds(parseDayInput('-3', now)!).date).toBe('2026-10-07')
    expect(dayBounds(parseDayInput('2026-01-02', now)!).date).toBe('2026-01-02')
    expect(parseDayInput('whenever', now)).toBeUndefined()
  })
})
