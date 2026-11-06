# 已知缺陷

本文件只记录**当前实现中真实存在、可复现**的缺陷。每条都给出可执行的复现命令；
命令引用本仓库中真实存在的脚本或测试文件，不描述非目标（non-goal），也不声称
代码里没有的修复。

### KI-01 发布游标（published cursor）未持久化

- 现象: 三条生成路径都把 `PublishCommit.publishedCursor` 写成 `null`（研究、比较、变更），
  `cursors` 表中因此没有 `kind='published'` 的记录。
- 影响: 更新流（`updates`）的“已发布”进度由 `change_events.state` / `published_at`
  推导；收件箱和变更详情的读取行为不受影响，但没有一个可独立回放的发布游标。
  discovery 游标已持久化，重启不会重放事件。
- 复现: `pnpm run test:learning -- test/learning/phase/c-gate.test.ts`
- 状态: 已知，v1 接受；发布游标作为后续增强项。

### KI-02 研究分析每次只生成一条 lesson

- 现象: `buildResearchLessons` 以第一个 wiki 页面作为主题，一次调用只返回一条
  lesson，不按 wiki 页面逐页扇出。
- 影响: 生成模块；大仓库的一次分析不会为每个页面生成独立讲解，读者需要自行在
  页面之间导航。PRD 未要求按页面扇出，因此不阻塞 v1。
- 复现: `pnpm run test:learning -- test/learning/lessons/builder-flows.test.ts`
- 状态: 已知，v1 接受。
