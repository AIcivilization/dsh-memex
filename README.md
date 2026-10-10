# dsh-memex

**Memex for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)** — every evening it reads what dsh did today and writes it down as a Markdown diary. · **dsh 的起居注**：每天自动整理 dsh 当天做了什么，存成日记。

## 它记录什么

数据来自 dsh 的 `ctx.sessionQuery`（实时 + 持久化会话，和模型看到的历史一致），按会话归纳：

| 内容 | 来源事件 |
| --- | --- |
| 会话标题、工作目录、起止时间 | session header + `session/title` |
| 你下达的指令 | `user/message` |
| 工具调用次数、读写的文件、执行的命令 | `tool/call` 参数 |
| 完成 / 未完成的待办 | 当天最后一次 `todo/write` |
| 出错的回合 | `turn/end`（error） |
| 最后的结果 | 当天最后一条 `assistant/message` |
| **今日总结**（可选） | 用当天最后使用的模型把以上内容写成一段叙述 + 按项目的成果 + 遗留问题 |

输出：`~/.dsh/memex/2026-10-10.md`，一天一个文件。

## 安装

```bash
dsh plugin --profile web add dsh-memex
```

## 配置

```yaml
dsh-memex:
  outputDir: "~/.dsh/memex"
  writeAt: "23:30"        # 每天几点写
  catchUpDays: 3          # 启动时补写最近几天缺失/没写完的日记
  summarize: true         # 让模型写「今日总结」；失败时只写事实部分
  # provider: deepseek    # 不填就沿用当天最后一个会话用的模型
  # model: deepseek-chat
  language: 中文
```

手动触发：`/memex`（今天）、`/memex 昨天`、`/memex -3`、`/memex 2026-10-01`。

## 设计

- **只读**：不往会话日志写任何东西，总结调用是独立的辅助请求。
- **补写**：dsh 没在 `writeAt` 时运行也不会漏——下次启动时把缺失或在当天结束前写的日记重写一遍。
- **故障隔离**：单个会话读取失败只跳过该会话；总结失败照样写事实日志。
- **零依赖**：只依赖宿主的 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`，dsh 内部接口按结构子集读取。

## 路线图

这是「每天自动记录电脑做了什么」的第一步：先把 dsh 的工作记下来。后续数据源可以按同样的 `collect → render → summarize` 管线接入：git 提交、shell 历史、浏览器历史、前台应用时长等。

## License

MIT © [AIcivilization](https://github.com/AIcivilization)
