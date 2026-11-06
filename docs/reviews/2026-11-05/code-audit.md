# Codetrail 代码检查报告

> 本文记录修复前基线。七项 P1 的修复、UI 实现和验证结果见 [修复记录](fixes/README.md)。

审阅日期：2026-11-05（Asia/Shanghai）。基线提交：`6fe814f217f92fd5de11da52f5d03144dc52e4c5`，结合当前工作区源码。

本次确认 **10 项重要问题：7 项 P1，3 项 P2**。最突出的是主流程之间没有连通：网页导入项目后无法启动分析；问答丢失会话入口；跟进任务只落库、不执行。另有缓存版本错误和问答用量失真。这些问题需要先于视觉重构修复。

P1 表示主要功能不可用、结果可能错误或资源约束失效，应优先修复；P2 表示状态一致性、用户意图或特定使用路径存在明显错误。

## 项目在做什么

这是一个面向个人的本地代码学习系统，以固定提交的 OpenWiki fork 为底座。它要把本地 Git / GitHub 仓库转换成中文分层讲解、模块与运行流程图、可追溯的源码证据，并支持连续追问和 PR / 默认分支变更跟进。

主要实现路径：

- `src/learning/projects`：仓库身份、独立镜像、提交快照、读取范围和覆盖报告。
- `src/learning/api/jobs`：生成任务、取消和重试、配额、封存与发布。
- `src/learning/lessons` / `upstream`：复用 OpenWiki 生成与检索能力，编排教学内容并检查证据。
- `src/learning/qa` / `evidence`：按版本绑定的只读问答、引用和来源注册。
- `src/learning/updates`：GitHub 轮询、变更发现、游标和收件箱。
- `src/learning/store`：SQLite 持久化。网页采用服务端 HTML 渲染、一个 TypeScript 浏览器增强脚本和 CSS。

审阅重点是 Codetrail 新增的上述链路、实际装配入口、相关测试和网页。没有逐行审计整个上游 fork，也未使用真实模型额度、真实私有仓库或线上 GitHub 凭据。

## 问题总览

| 编号 | 优先级 | 问题                                     | 主要影响                                           |
| ---- | ------ | ---------------------------------------- | -------------------------------------------------- |
| R1   | P1     | 网页没有模型配置和分析提交入口           | 新用户无法独立获得第一份讲解                       |
| R2   | P1     | 保存模型配置不会更新运行时模型           | 保存成功后仍无法分析，或继续调用旧模型             |
| R3   | P1     | 问答按 JSON 读取 SSE，且不保存新会话入口 | 回答无实时反馈，首次提问后历史不可见，连续追问断开 |
| R4   | P1     | 发现流程写入的 queued 任务不会被执行     | 持续跟进停在排队，重启也无法恢复排队任务           |
| R5   | P1     | 对比缓存没有区分实际 base SHA            | 不同对比可能返回同一份错误讲解                     |
| R6   | P2     | 任务去重先于偏好版本缓存判断             | 修改偏好后仍返回旧偏好的生成结果                   |
| R7   | P1     | 证据链接的 source 参数完全没有处理       | 点击源码引用无法查看对应证据                       |
| R8   | P1     | 问答绕过配额和用量记录                   | 配额不生效，“追问”用量长期为零                     |
| R9   | P2     | 网页阅读路径绕过 API 的版本/移除检查     | 已移除内容仍正常展示，错误项目可能显示其他项目     |
| R10  | P2     | 移除确认框没有参与提交判断               | 未勾选确认也会发送确认移除请求                     |

以下条目均已通过补充诊断复现。R1 结合页面控制项检查和源码确认；R5 使用种入的已发布结果验证生产 runner 的缓存行为；浏览器交互诊断使用当前源码即时转译后的 DOM 环境。具体输出见文末。

## R1 · P1：网页缺失完成首次学习所需的操作

**位置：** [projects.ts:37](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/pages/projects.ts:37)、[settings.ts:85](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/pages/settings.ts:85)、[client.ts:372](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/client.ts:372)。

项目页只有导入、打开阅读和查看移除依赖；设置页的 provider/model 只是文本。浏览器脚本没有调用分析或对比 API 的路径。导入 API 也只创建项目，不提交分析。因此全新安装即使导入成功，仍无法在网页内配置模型、开始生成并抵达有内容的阅读器。

GitHub 表单虽然收集 `ref`，但 [projects.ts:336](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/routes/projects.ts:336) 的创建处理过程没有消费这个字段，未将用户的版本选择形成可继续使用的研究上下文。

**建议：** 补齐“配置模型 → 导入 → 确认提交与范围 → 开始分析 → 查看任务 → 开始学习”的操作链；项目卡片主操作按状态切换为“开始分析 / 查看进度 / 继续学习 / 重试”。版本输入应解析并显示实际 SHA。

**验收：** 空数据目录启动后，只用网页操作即可完成第一次分析；过程中能看见失败原因、取消和重试入口。

## R2 · P1：模型配置保存成功，运行时仍使用启动时的快照

**位置：** [cli.ts:260](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/cli.ts:260)、[cli.ts:276](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/cli.ts:276)、[settings.ts:122](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/routes/settings.ts:122)。

`createAppDeps` 只在启动时创建 ModelHandle，并把该值分别传给任务和问答服务。PUT 设置只写数据库，没有替换这些依赖。无配置启动后，即使 PUT 返回 200、数据库已有配置，`deps.model` 仍为 null；已有配置启动后更换模型，实际请求仍使用旧 handle。生成配置散列又从数据库读取，可能记录新模型配置、实际调用旧模型。

**复现结果：** `saveStatus:200, persisted:"audit-model", runtimeModel:null`。

**建议：** 使用统一的模型解析服务，每个新任务/问答回合获取当前有效配置并固定到该回合；保存时验证支持的 provider。若暂时仅支持重启生效，界面和 API 必须明确标记待生效配置，并避免让生成元数据宣称使用了新模型。

**验收：** 首次保存后无需重启即可分析；修改模型后，新任务元数据与实际调用模型一致，正在执行的任务保留自身配置。

## R3 · P1：问答的浏览器和服务器使用了不同协议，会话入口也丢失

**位置：** [client.ts:15](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/client.ts:15)、[client.ts:243](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/client.ts:243)、[conversations.ts:274](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/routes/conversations.ts:274)、[static.ts:424](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/static.ts:424)。

消息 POST 返回 SSE，客户端却调用 `response.json()`。它会等待整个响应结束，解析失败后仅得到 null，又因为 HTTP 200 执行 reload。SSE 内的业务 error 也没有展示。

首次创建 conversation 后，客户端既不更新 form 的 conversationId，也不写入 URL。服务端只有收到 `?conversation=…` 才加载消息。因此从普通项目入口首次提问后，刷新页面仍显示“尚无追问”，下一次提问又创建新会话。切换 lesson 的链接也未保留 conversation 参数。

**复现结果：** 连续两次提交创建两个会话；SSE 被尝试解析为 JSON 两次；form conversation 仍为空，URL 中无会话参数。

**建议：** 独立实现 POST SSE 事件读取，逐事件处理 start/delta/error/done；创建成功立即持久化会话入口；切换章节时保留绑定。按事件结束状态处理成功和失败，不以 HTTP 200 代替业务成功。发送期间提供状态和取消操作。

**验收：** 连续三轮追问只使用同一会话；刷新和切换章节后历史保留；模型未配置、断连、预算耗尽都可见。

## R4 · P1：持久队列和执行队列脱节

**位置：** [discovery.ts:191](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/updates/discovery.ts:191)、[discovery.ts:252](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/updates/discovery.ts:252)、[runner.ts:318](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/jobs/runner.ts:318)、[runner.ts:450](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/jobs/runner.ts:450)。

发现事务直接插入 queued 行，但 runner 仅执行内存 `pending` 队列。轮询没有把新行交给调度器。重新调用 enqueue 也因命中已有 dedupeKey 直接返回，retry 则不接受 queued 状态。重启恢复只处理 running/cancelling，已经落库的排队任务同样无法进入内存队列。

**复现结果：** 插入 queued 后依次执行恢复、再次 enqueue 和 drain，仍为 `queued`，模型调用数为 0。

此问题已记录于 `docs/known-issues.md` 的 KI-03；“v1 接受”不改变它对自动跟进这一主功能的影响。

**建议：** 以数据库 queued 行作为任务来源，或提供可靠的队列唤醒及启动恢复机制。应保证“事件/任务/游标同事务落库”，提交后唤醒失败也能被后续扫描恢复；不要单纯在事务内部调用现有 enqueue 破坏原子性。

**验收：** 真实 scheduler + discovery + runner 连通测试中，无手工调用 executeJob，变更自动发布；重启前落库的 queued 任务能够继续。

## R5 · P1：对比缓存丢失了实际对比基准

**位置：** [keys.ts:39](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/contracts/keys.ts:39)、[runner.ts:295](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/jobs/runner.ts:295)、[pipeline.ts:912](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/jobs/pipeline.ts:912)。

任务 dedupeKey 包含 comparisonBaseSha，但生成 cacheKey 只包含 head 和 merge-base，没有实际 base SHA，也没有生成种类。设 B1、B2 位于一条分支，H 位于另一条分支，二者与 H 的 merge-base 都为 A：`B1→H` 与 `B2→H` 的 diff 不同，但会命中同一个生成缓存。runner 不检查缓存行的 comparisonBaseSha，直接把已有生成当成结果。

**复现结果：** 种入 base=`bbbb…` 的已发布对比后，提交 base=`cccc…`、相同 head/merge-base 的请求；任务直接 completed，返回版本的 comparisonBaseSha 仍为 `bbbb…`。

**建议：** 对比缓存显式包含 kind、baseSha、headSha、mergeBaseSha；研究与变更缓存使用各自完整语义。升级缓存键版本，避免继续命中旧键。

**验收：** 同 head、同 merge-base、不同 base 的结果必须不同；相同对比仍可零调用命中。

## R6 · P2：偏好版本虽然进入缓存键，却被更早的任务去重绕过

**位置：** [keys.ts:18](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/contracts/keys.ts:18)、[runner.ts:318](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/jobs/runner.ts:318)。

cacheKey 包含 preferencesVersion，但 dedupeKey 不包含。enqueue 先返回历史相同任务，再考虑当前偏好对应的缓存。用户改变自述基础或解释偏好后，对同一提交重新分析会拿到旧结果。

**复现结果：** 当前偏好 version=1，返回生成的 preferencesVersion 仍为 0；同一 jobId，新增模型调用为 0。

**建议：** 将生成所需的偏好版本在提交时固定到任务输入，并纳入任务身份及生成身份；不要到执行/发布时多次读取可能改变的全局版本。

**验收：** 改偏好后同一 SHA 产生新任务和新生成；只改阅读位置仍可复用缓存。

## R7 · P1：证据链接能点击，但不会展示对应来源

**位置：** [reader.ts:101](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/pages/reader.ts:101)、[terms.ts:49](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/pages/terms.ts:49)、[static.ts:406](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/static.ts:406)。

讲解证据、问答引用和术语来源均指向 `/learn/reader?generation=…&source=…`，但页面模型与客户端都不读取 source。点击来源只重新渲染阅读器，不读取 source API、不显示代码、不定位行号。

**复现结果：** 相同 generation 下 source 分别为 `s_one`、`s_two` 的完整响应相同；实际浏览器点击引用后，只有 URL 变化，页面内容不变。

**建议：** 让 source 参数对应可深链的证据面板，显示路径、固定 SHA、行号和代码，支持“针对该段代码追问”。来源不存在/已移除应展示明确状态。

**验收：** 从讲解、问答引用、术语三处均可抵达正确版本的同一证据；刷新后仍停留在该来源。

## R8 · P1：问答没有接入应用级配额与用量统计

**位置：** [answer.ts:548](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/qa/answer.ts:548)、[ports.ts:596](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/contracts/ports.ts:596)、[cli.ts:299](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/cli.ts:299)。

生成任务通过 meteredHandle 调用模型，问答直接 `model.chat().bindTools().invoke()`。AnswerDeps 没有 UsageMeter，因此未执行已配置配额检查，也未记录成功调用。QA_LIMITS 的工具次数/上下文限制不能替代应用设置中的模型调用和 token 配额。

**复现结果：** 将 maxCalls、maxInputTokens、maxOutputTokens 全设为 1 后，两个问答仍产生 2 次模型调用，`qa` 用量行数为 0。

**建议：** 生成与问答共用调用计量入口，在每次模型请求前检查预算，调用后记录真实消耗，携带 conversationId；失败或取消时保留已发生的调用消耗。

**验收：** 达到配额后，下一次问答在发起 provider 请求前失败；用量页显示与调用日志一致的追问数据。

## R9 · P2：网页绕过了 API 已有的版本和移除规则

**位置：** [static.ts:202](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/static.ts:202)、[static.ts:406](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/static.ts:406)，对照 [generations.ts:166](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/api/routes/generations.ts:166)。

API 使用 requirePublishedGeneration，区分不存在、未发布、项目已移除；网页直接按 ID 取生成和文件，没有复用这些检查。软删除保留文件，导致旧阅读链接仍返回正常讲解。另外，指定不存在的 project 时会进入默认回退循环，可能展示第一个其他项目；不存在的 lesson 也会静默选第一篇。

**复现结果：** 移除项目后，同一生成的 API 报 `source_removed`，阅读器仍为 HTTP 200 且显示讲解正文。

**建议：** 抽取网页/API 共用的读取服务，统一校验 generation、project、lesson、conversation 的状态与归属；显式指定的失效 ID 应展示失效状态，只有完全未指定时才应用默认选择。

**验收：** 旧链接返回一致的不可用页面；错误项目不显示其他项目；未发布版本不会被网页当成正式版本展示。

## R10 · P2：移除确认框没有约束移除操作

**位置：** [client.ts:125](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/client.ts:125)、[client.ts:135](/Users/huaxinzhang/Desktop/trifles/codetrail/src/learning/ui/client.ts:135)。

依赖请求成功后，脚本直接启用移除按钮，没有等待勾选；submit 处理器从不读取 checkbox，却无条件附加 `?confirm=true`。确认框没有 required 属性。用户点击“查看移除依赖”后，无需勾选就能移除项目，并取消相关任务。

**复现结果：** checkbox.checked=false、移除按钮已启用，提交仍发送 DELETE confirm=true。

**建议：** 将移除放入包含项目名称的独立确认对话框；依赖加载成功且明确确认后才启用提交；切换项目必须清空确认状态，避免异步返回把 A 的依赖显示在 B 的操作下。

**验收：** 未确认不会产生删除请求；切换项目后不能复用前一个项目的确认。

## 验证结果与局限

1. `pnpm run typecheck` 通过，完整输出在 [typecheck.log](typecheck.log)。
2. 定向运行以下 5 个测试文件：**25/25 通过**，完整输出在 [targeted-verified.log](targeted-verified.log)：
   - `test/learning/ui/project-forms-client.test.ts`
   - `test/learning/api/settings-model.test.ts`
   - `test/learning/integration/ui-selection-qa-conversation-binding.test.ts`
   - `test/learning/integration/publish-ui-reader-render.test.ts`
   - `test/learning/integration/watch-refresh-change-inbox-flow.test.ts`
3. 新增的 [reproduce.mts](reproduce.mts) 逐项确认上面 10 个现象；它断言的是当前缺陷表现，**不是期望行为的回归测试，也不应直接纳入 CI**。输出见 [reproduction.log](reproduction.log)。运行：

   ```sh
   node --import tsx docs/reviews/2026-11-05/reproduce.mts
   ```

4. 实际浏览器检查使用当前源码服务端渲染器、当前构建的静态资源和临时示例数据，记录了项目、阅读、设置三个页面。截图见 UI 方案；模型未配置，未消耗真实模型额度。客户端缺陷诊断另行转译了当前 `client.ts`，避免仅依赖旧构建。
5. 首次测试遇到沙箱禁止回环监听，报 listen EPERM。获准本机监听后，相同定向范围全部通过；该环境错误不计入代码缺陷。[完整失败输出](targeted-sandbox-failure.log)。最初通过包管理器传参的测试意外扩大到整个 learning 范围，已中止；[保留日志](initial-test-attempt-interrupted.log)，不以此给出全量测试结论。

现有测试覆盖了不少模块契约，但没有证明“从空安装开始，仅用浏览器完成学习和连续追问”。例如手工传入 conversation 参数可以验证历史渲染，却不能发现首次创建会话后丢失入口；只验证发现行已落库，也不能证明 runner 真正启动。

## 建议修复顺序

先处理 R1/R2/R3/R4，恢复导入、分析、阅读、追问、跟进的操作闭环；同时修 R5/R8，避免错误对比结果和资源约束失效。接着统一读取服务并处理 R6/R7/R9/R10，再围绕完整流程实现 UI 方案。缓存键调整需要版本升级，不能只改外观或新增按钮。

配套方案：[UI 与交互优化方案](ui-optimization.md)。本次新增审阅材料与诊断，不修改业务源码。
