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
- 支持：立即停止、本局肉鸽结算后停止、再完成 N 局后停止、下一处 Boss 前停止、精确指定层 Boss 前停止、取消尚未触发条件、查询可靠进度。“再完成 N 局”不受初始刷取次数 9999 影响；下一处 Boss 条件可在任务开始后动态添加。
- 新停止条件会覆盖旧的未触发停止条件；已触发的条件不能撤回。非肉鸽任务不会接受肉鸽条件。
- 运行中招募偏好记录为 `unsupported`：未修改配置、未写入长期策略记忆、未声称生效。

## 阶段 3：入口、界面与文档（已完成）

- 新增模型工具 `maa_runtime_instruction`，普通 DSH 对话可调用；常用表达同时由 `/maa` 本地命令零模型解析。
- 运行控制面板改为单一自然语言输入框，不再为每项运行时能力放置专用按钮；提交后由本地解析器反馈应用或拒绝结果，不增加轮询。
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

## 阶段 6：v1.0.4 智能诊断与安全恢复（核心已实现，集成验证中）

- 新增 `src/agent/recovery-manager.js`：区分结构化回调确认的故障与日志推测故障，分类 ADB 连接/截图、初始化、资源不匹配、任务链异常、识别失败和未知失败。
- 自动重试严格限制为尚无完成检查点的 `Depot` / `OperBox` 只读扫描，最多 2 次，退避 1 秒 / 3 秒；Fight、公招、商店、领奖、基建等可能改变状态的任务禁止自动重试。
- 执行台账新增恢复状态、诊断、历史和 TaskChain 检查点；连接故障重试前先只读探测 ADB，端口仍不可达时转为 `needs_user`。
- 新增 `src/operators/depot.js`：解析官方 `DepotInfo(done=true)`、原子保存 `depot.json`、结合 MAA `item_index.json` 查询真实库存；后台执行结束时与 OperBox 一起落盘。
- 当前新增测试 5 项通过；完整回归、重启审计和控制面板展示仍待本阶段收尾。

## 阶段 7：v1.0.4 恢复闭环（已完成）

- `src/index.js` 已将 Recovery Manager 接入前台与后台执行：失败后写入诊断、恢复历史和人工介入状态；仅只读 Box / Depot 扫描可在 ADB 仍可达、无完成检查点时有限重试。
- 运行面板显示恢复状态、重试次数、确认/推测故障和人工处理标记；结束记录保留最后诊断。
- 插件启动时审计中断的运行/工作流，只清理 `dsh-generated` 进程并恢复策略覆盖；活跃记录窗口改为 7 小时，与 6 小时进程硬上限一致，避免长任务被误判为可并发。
- ADB 断连、端口仍不可达、已有完成检查点、消耗性任务和达到重试上限的测试均验证会停止自动恢复。

## 阶段 8：v1.1.0 目标与工作流（已完成）

- 新增 `src/agent/goal-manager.js`：日常、干员培养、材料、自定义目标；读取真实 OperBox/Depot 与 MAA 物品/关卡索引，计算材料缺口和理智预算，缺数据时不把未知当 0。
- 新增 `src/agent/workflow-manager.js`：独立 `workflows.json`，预设保存/编辑/删除/复用、执行游标、步骤状态、人工决策点、中断审计；`goals.json` 独立保存长期目标。
- 新增 `maa_depot`、`maa_goal_manager`、`maa_workflow_manager`；目标和预设仍通过一次性确认码，确认后后台逐步执行。只有 MAA 明确验证步骤完成且结构化缓存成功才推进；未验证即 `needs_review`。
- 工作流执行完成后目标进入 `awaiting_goal_verification`，严格区别“进程结束 / MAA 步骤完成 / 游戏目标达成”。确认面板显示目标事实、步骤数和完成条件。
- MAA 本身不提供通用升级材料需求表和统计掉率；已新增独立的、可审计在线数据层补齐这两项，详见阶段 10。缺少可靠缓存、关卡样本或预算时仍请求人工决策，不自动猜测。

## 阶段 9：验证与文档（已完成）

- 新增 Depot、Recovery、Goal、Workflow 测试，覆盖库存解析、故障分类、有限重试、缺口计算、预算阻断、预设 CRUD、一次性确认以及重启后不重放不确定步骤。
- 使用实际私有运行时 `maa-cli v0.7.7 / MaaCore v6.20.1` 的 `--dry-run` 验证安全日常工作流（StartUp/Infrast/Mall/Award）配置解析成功；未连接模拟器、未操作游戏。
- 全量自动测试：`node --test test/*.test.mjs` → 177/177 通过；`git diff --check` 通过。
- `npm pack --dry-run --json` 通过：33 个发布文件，161,409 B（解包 553,183 B），包含新增 `src/agent/*`、培养数据与 Depot 模块，不包含测试和交接文档，未生成 tgz。
- README、CHANGELOG 已更新；正式 `package.json` 仍为 `1.0.3`，未提交、未推送、未发布。
- 未进行模拟器/游戏实机执行；日常顺序执行、真实 Depot/OperBox 回调、ADB 断连后的界面反馈和 DSH 重启恢复仍需用户在 DSH Desktop 中验证。自动测试与 `--dry-run` 不冒充实机结果。

## 阶段 10：培养需求与掉率自动更新（已完成）

- 新增 `src/agent/planning-data.js`：按 CN/US/JP/KR 从 ArknightsGamedata 拉取 `character_table.json` 与 `gamedata_const.json`，提取干员精英化材料、等级经验/龙门币和晋升龙门币；从企鹅物流统计 Matrix API 获取当前掉率。
- 数据压缩后原子保存到 `planning-data.json`，最多每 24 小时更新一次，记录 URL、ETag、Last-Modified 和 SHA-256；刷新失败沿用上次完整验证缓存并标记 `stale`，不写入半份数据。
- Goal Manager 的干员培养目标默认规划到精二 1 级，也支持 `targetElite` / `targetLevel`；根据 OperBox 当前状态、Depot 库存自动生成材料缺口。
- 掉率只接受当前 MAA `stages.json` 可匹配、有效期未结束且样本数至少 100 的记录，按期望理智排序；一次只安排一个刷取批次，随后执行 Depot 重扫并停在重新规划点。
- `maa_goal_manager` 新增 `data_status` / `refresh_data`；在线数据只写本地状态缓存，不进入 npm 发布包。
- 真实上游刷新验证：CN 数据 `stale=false`，提取 1,392 条角色记录与 8,064 条 Matrix 记录；结城理精二需求生成 8 类物品，并成功匹配 PR-D-1、S3-2、S3-3、17-11、LS-6 等当前 MAA 关卡及其样本量。该验证未连接模拟器、未执行游戏任务。

## 阶段 11：自然语言运行控制面板（已完成）

- 运行面板不再展示立即停止、本局结束、取消条件、查询进度等功能专用按钮，只保留一个自然语言输入框和通用“发送指令”按钮；输入统一交给 `/maa` 本地运行时解析链路，并回显已应用、未应用或无法识别。
- 新增 `stop_before_next_boss`：任务已经开始后输入“这次 Boss 关前停止”即可挂载，不依赖确认面板高级设置；只接受 `StageDreadfulFoe` / `StageDreadfulFoe-<层数>` 节点回调，不接受 `...Enter`，避免在已经进入战斗后才停止。
- “再打 N 局结束/就停”支持空格、阿拉伯数字和中文小数字，范围为 1–9999；目标值按收到指令时的 `RoguelikeSettlement` 已结算数计算，与原计划 `starts_count=9999` 相互独立。
- 修正运行时条件的能力反馈：只有日志监控器实际创建成功才标记条件为 `applied`；没有监控器时保留为 `received_not_applied`，不会虚报已生效。立即停止仍可直接使用进程控制句柄。
- 全量自动测试 `178/178` 通过，覆盖初始 `starts_count=9999` 后动态设置两局、运行后新增下一 Boss 条件、过滤已经进入战斗的回调，以及面板无专用按钮。`git diff --check` 通过；`npm pack --dry-run --json` 为 33 个文件、162,012 B，未生成 tgz。未进行真实游戏实机验证。

