# AGENT PROGRESS — Runtime Instructions

> 更新时间：2026-10-30｜本文件记录本轮“运行时自然语言交互与动态任务控制”进度。已准备 1.0.3，未提交、未推送、未发布。

## 阶段 1：现状与接口边界（已完成）

- 已读取 `AGENT_HANDOFF.md`、当前 Git 状态及后台执行、运行记录、命令面板相关代码。
- 已确认现有后台 `startMaa` 不阻塞 DSH 命令接收，并已有可终止当前子进程树的控制句柄。
- 已核对当前 MAA/MaaCore 接口：MaaCore 原生 `AsstSetTaskParams` 需要同一进程内的 Assistant 句柄和 task id；当前架构由独立 `maa-cli run` 子进程持有这些对象，未提供运行时 IPC。因此当前任务内动态修改招募参数不能可靠实现，必须明确返回“未应用”，不能以写配置文件冒充生效。
- 已从真实 `asst.log` 确认可用于可靠控制的回调：`RoguelikeSettlement`（一局探索结算）、`StageDreadfulFoe-<层数>`（进入指定层 Boss 节点之前）、`StageInfo`、`BlackFlowMapSummary`。
- 安全边界：只有回调明确提供局数、层数或节点时才更新/触发；无法识别时保持待定并报告未知，不猜测。

## 阶段 2：核心实现（已完成）

- 新增 `src/commands/runtime-instructions.js`：本地自然语言解析、运行时指令应用/覆盖/取消、MAA 回调解析、增量日志监控和条件触发。
- `runs.json` 新增 `progress`、`taskTypes`、`instructions`；指令状态区分 `received / applied / triggered / completed / cancelled / unsupported`，并采用串行原子写避免日志回调与用户命令互相覆盖。
- 当前后台执行通过 `maa-cli dir log` 定位实际 `asst.log`，只读取进程启动后新增的日志；进程退出前刷新并停止监控。
- 支持：立即停止、本局肉鸽结算后停止、再完成 N 局后停止、精确指定层 Boss 前停止、取消尚未触发条件、查询可靠进度。
- 新停止条件会覆盖旧的未触发停止条件；已触发的条件不能撤回。非肉鸽任务不会接受肉鸽条件。
- 运行中招募偏好记录为 `unsupported`：未修改配置、未写入长期策略记忆、未声称生效。

## 阶段 3：入口、界面与文档（已完成）

- 新增模型工具 `maa_runtime_instruction`，普通 DSH 对话可调用；常用表达同时由 `/maa` 本地命令零模型解析。
- 运行控制面板新增「本局结束后停」「取消停止条件」「查看实时进度」，继续保留立即停止；不增加轮询。
- README 和 CHANGELOG 已说明语义、状态流转、可靠性边界及招募动态修改限制。

## 阶段 4：验证（已完成，实机部分待用户运行）

- 全量自动测试：`node --test test/*.test.mjs` → 156/156 通过；`git diff --check` 通过。
- 新增模拟长任务闭环：fake maa-cli 保持运行时仍可接收条件；追加真实格式的 `RoguelikeSettlement` 日志后，条件触发并终止该 fake 进程树，最终状态为 `stopped`，指令为 `completed`。
- 覆盖：本地同义表达、两局计数、精确 Boss 层、覆盖与取消、非肉鸽回退、招募未支持、只读取新日志。
- 用当前私有运行时的真实 `asst.log` 抽样验证解析器：识别到 `RoguelikeSettlement` 1 条、`BlackFlowMapSummary` 2 条、`StageInfo` 17 条、`StageDreadfulFoe-5` 的 `SubTaskStart` 1 条；格式与触发器一致。
- 尚未启动真实模拟器或真实 MAA 游戏任务；真实 JieGarden/BlackFlow 的长任务触发时机仍需重启 DSH 后实机验证。未提交、未推送、未发布。

## 阶段 5：1.0.3 发布准备（已完成）

- `package.json` 版本更新为 `1.0.3`。
- CHANGELOG 的未发布内容整理为 `1.0.3 - 2026-10-30`，README 同步当前运行控制按钮和查询方式。
- 发布前验证：156/156 测试通过，README 相对链接通过，`npm pack --dry-run --json` 生成 29 文件清单（136,028 B，解包 465,754 B），未包含测试、交接或进度文档，且未实际生成 tgz。
- 未执行 Git 提交、推送、打 tag 或 npm 发布。

