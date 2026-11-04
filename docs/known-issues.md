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

### KI-03 跟进发现的变更任务不会自动开始执行

- 现象: `commitDiscovery` 在事务里直接用 `insertJobRow` 写入 `queued` 状态的
  `change_analysis` 任务；而 `JobRunner` 的待执行队列只在 `enqueue()` / `retry()`
  被调用时才加入任务，发现流程并不调用它，重启时的 `recoverInterrupted()` 也只
  处理 `running` / `cancelling`。因此跟进（watch tick）产生的变更任务会一直停在
  `queued`，除非有人显式推动它。
- 影响: 跟进流程；事件、游标与收件箱记录都正确落库，但“发现即分析”这一环需要
  外部推动。`test/learning/phase/d-gate.test.ts` 的跟进流程因此自行把 `queued`
  任务交给生产 `executeJob` 执行，以验证分析与发布逻辑本身。
- 复现: `pnpm run test:learning -- test/learning/phase/d-gate.test.ts`
- 状态: 已知，v1 接受；后续把发现产生的任务接入 runner 队列即可修复。
