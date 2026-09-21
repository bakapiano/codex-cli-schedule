# 真实 Codex CLI E2E

请使用独立测试会话与测试数据目录。测试内容限定为文本确认，模型调用会使用当前 Codex 账号。

1. 构建并安装包，注册 `codex_schedule` MCP。
2. 新开独立 Codex CLI，确认 MCP 工具可见。
3. 让 Codex 通过 MCP 创建一个暂停的测试任务，列出、修改、读取、删除，并检查列表恢复为空。
4. 在独立交互式 Codex CLI 中发送一个文本确认 prompt，保持该终端打开，用 `/status` 获取该会话 ID。
5. 从另一个终端创建一次性任务，几秒后向该会话投递 `请仅回复 SCHEDULE_EXISTING_E2E_OK，本轮仅进行文本回复。`。
6. 查看 `runs` 的 `queued` 记录，并确认原终端输出相应回复。继续向原终端发送文本，验证会话依然由该终端控制。
7. 创建一个 `--new` 一次性任务，等待 `runs` 返回新的 `sessionId`。
8. 用户从独立终端执行 `codex resume <新ID>`，确认成功打开并消费此前排队的 `SCHEDULE_NEW_E2E_OK` 测试 prompt。
9. 删除所有测试 schedule，保留投递记录；关闭测试终端。检查 daemon 仍能响应 `status`。

可使用独立 `codex exec` 进程验证 MCP CRUD；队列消费测试使用交互式 CLI，以覆盖终端所有权和退出/重新打开行为。

请将原始日志保存在 git 忽略的 `artifacts/` 中。提交代码时保留通用测试流程，避免将本机会话历史、绝对路径、账号信息与管理令牌上传。
