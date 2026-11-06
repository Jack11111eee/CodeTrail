# 分层页面生成与空页面恢复修复

## 实际任务

任务 `j_9149d74918a85f0b` 的第 4 次尝试已通过规划，得到 25 篇页面的规划；在第一个页面 `/openwiki/architecture/core-and-adapters.md` 生成期间失败，耗时约 8 分 9 秒。

最后一次模型调用记录的输出为 4,096 tokens，恰好达到单次上限。页面没有成功写出，页面工作者进入恢复/重试路径。恢复时删除不存在的页面，底层 DeepAgents 在解析不存在的父目录时返回 `Error deleting ... ENOENT: no such file or directory, lstat .../openwiki/architecture`。

原有缺失文件识别只处理 `file_not_found` 和包含 `not found` 的文字，没有识别这种包装后的 Node ENOENT，因此把一次本应成功的空页面恢复升级为整项任务失败。目录是临时生成内容的目录，不是项目源代码。

## 修复

- 识别标准 `ENOENT: no such file or directory` 的包装错误。页面原本不存在时，恢复为空页面不再因为父目录不存在而失败；其他错误仍会传播。
- 新增真实目录回归，覆盖未写出的分层页面先恢复（仍 pending）、再跳过（标为 skipped），以及权限错误不被误当成缺失页面。修复前复现了与用户完全相同的错误，完整失败输出见 [page-restore-before.log](page-restore-before.log)。
- 页面模型响应结束但尚未完成时，根据当前文件判断恢复步骤：尚未有效写入时，要求复用研究上下文精简写入；已经写入但未提交时，要求精简 `submit_page` 的 Claims 提交。
- 恢复请求只开放相应的写入/编辑或提交工具，强制工具调用，不回放截断的助手尾部，不重复读取已有研究内容。每次页面工作者尝试的写入和提交步骤各最多恢复一次，仍受现有页面尝试次数、配额和取消信号限制。
- 处理底层 `readRaw` 对缺失文件直接抛出的 ENOENT，同时兼容返回错误对象的形式；不能把路径检查引入的缺失文件异常再次变成生成失败。
- 面板通过结构化活动显示“正在精简并写入页面”及“正在精简并提交页面”。模型配置及单次 4,096 上限保持原值。

## 验证

- 构建和 ESLint 通过：[page-build.log](page-build.log)、[page-lint.log](page-lint.log)。
- 上游生命周期、Agent、文档后端和提示词回归：**4 个文件、108 项通过**：[page-upstream-final.log](page-upstream-final.log)。
- 学习模块回归：**57 个文件、190 项通过**：[page-learning-final.log](page-learning-final.log)。
- 新增真实 SDK + DeepAgents + 文件系统 + Claims 的端到端回归，注入页面写入响应截断、提交响应截断，以及第一次定向写入也失败的情况。最终两篇页面均实际写出并进入完成清单；没有通过仅吞掉错误或空清单来使测试通过。
- 当前真实模型在只有 README 的临时仓库中完成了规划、页面写入、Claims 提交及最终校验。共 9 次调用，累计输入 38,701、输出 2,562 tokens；诊断单次输出上限为 2,048，没有写入用户配置。成功后临时仓库已清理。日志与结果：[real-page-smoke.log](real-page-smoke.log)、[real-page-result.json](real-page-result.json)。
- 原始 25 篇文档项目没有在本轮再次整仓运行，因此未将上述小仓库成功表述为用户项目已完成。

确认无进行中任务后，4320 服务已重新启动以载入修复，用户刷新后可重试原任务。第 4 次历史失败记录保留原样。
