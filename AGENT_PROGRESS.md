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

## 阶段 12：全命令面板参数持久化（已完成）

- `src/commands/panel-memory.js` 升级为 v2，继续复用同一个 `panel-memory.json`；所有带参数的 `/maa` 面板都按命令独立保存布尔、数值、下拉、多选、列表和文本字段。写入串行化并使用临时文件原子替换，避免并发确认丢失其他命令的配置。
- 只在服务端成功消费一次性确认后写入正式记忆；打开面板、未确认修改、取消和校验失败均不覆盖旧记忆。不同命令的记忆互不影响。
- 肉鸽按主题保存完整配置，另外记住最后确认的主题。客户端主题切换先保留当前未确认草稿，再恢复目标主题草稿或服务端历史；能力签名改变时会丢弃旧草稿并重新校验。
- 预填优先级为“本次显式参数 > 历史配置 > 动态能力默认值”。资源更新后逐字段验证历史值，只跳过失效字段；v1 肉鸽文件可直接读取，下次确认时迁移为 v2。
- 回归测试覆盖全部参数面板、命令隔离、并发写入、跨读取恢复、界园 → 萨米 → 界园、高级设置草稿、显式参数覆盖、字段级失效回退、v1 迁移、未确认不落盘和损坏文件回退。全量自动测试 `182/182` 通过；`git diff --check` 通过；`npm pack --dry-run --json` 通过（33 个文件，163,283 B，解包 559,515 B），未生成 tgz。
- 本阶段未连接模拟器或执行真实游戏任务；持久化、参数传递和 UI 切换通过文件级/集成自动测试验证，不冒充实机验证。未执行 Git 提交、推送、打标签或 npm 发布，未修改版本号。


## 阶段 13：确认面板 / 运行面板的停止、最小化、关闭与状态统一（已完成，未实机验证）

> 2026-10-31。未修改版本号，未提交、未推送、未发布。本轮在云端 Linux 工作区完成（通过文件桥读写本机项目，**没有在本机 Windows 上运行任何命令**）。

### 根因

1. **停止按钮被禁用 / 看起来消失**：`summarizeRun` 用 `Number.isFinite(Number(run.stopRequestedAt))` 判断“停止中”。`stopRequestedAt` 初始为 `null`，`Number(null) === 0` 是有限数，所以**每条执行中记录都被报告为 `stopping: true`**；面板一读 `/maa status`，「停止任务」就变成禁用的「正在停止…」。`markRunStopping` 的同一判断导致停止时间从未写入。修复：`hasStopRequest()` 只认正的数字时间戳。
2. **确认成功被当成运行结束**：后台执行后 `/maa confirm` 成功 = 任务已开始，但确认条的 `onSuccess` 仍按旧语义 `forgetRun()` + `store.complete()`，面板变成没有停止按钮的“执行结果”；从工具卡确认时确认条的本地运行记录只在挂载时从 localStorage 读一次，永远不会显示运行面板。运行状态分散在组件 state、全局 localStorage（不分会话）和计划 store 三处，互相覆盖（旧快照里的 `recent[0]` 会压过新的本地运行）。
3. **最小化后恢复异常**：折叠时条件渲染卸载了 `ConfirmButton` 等子树，展开后本地状态（备注预览、执行中状态、停止按钮）丢失；执行结果视图的「×」会对已消费的确认码调用 `/maa cancel` 而报错。
4. **关闭/停止不精确**：`/maa stop` 停“当前任何任务”（跨会话），并对所有工作流 `abort()`；兜底清理杀所有 `dsh-generated` 进程；停止期间若 `taskkill` 失败会无限等待；确认仍在启动阶段（尚未有运行记录）时无法停止。

### 修改

- `src/runtime/state.js` / `src/commands/confirmation.js`：`pending-plans.json` 新增 `closed`（确认码失效记录，24 小时、最多 500 条，按会话隔离），覆盖 cancelled / confirmed / superseded / expired。所有确认入口（`/maa confirm`、模型 `consumeConfirmedPlan`、`assertPlanCodeOpen`）对失效码给出确切原因；`cancelPendingPlan` 幂等，确认已胜出时抛 `MAA_PLAN_CONFIRMED`（带 `runId`）；`recordPlanRun` 把运行 id 写回失效记录。生成的新确认码不会与失效码碰撞。
- `src/commands/run-state.js`：`hasStopRequest`、`setRunProcess`、`clearRunStopping`、`reapRunProcessTree(pid)`、`isProcessAlive`；记录新增 `ownerPid`（插件主机进程）、`pid`（cmd.exe 根进程）、`stopError`；`finishRun` 第一次终态为准；`stopRun` 只用于“非本进程持有”的记录，按 pid 定位进程树、要求命令行含 `dsh-generated`，失败时清除 stopping、写 `stopError` 并抛 `MAA_STOP_FAILED`；无 pid 的旧记录才回退到旧的名称匹配。
- `src/runtime/runner.js`：`startMaa().kill()` 返回可等待结果（taskkill 退出码，128=已不存在视为成功），重复调用会重新下发终止；`exited` getter。非 Windows 改为直接 spawn + 独立进程组（只为开发/CI；Windows 路径不变）。
- `src/index.js`：
  - `stopExecution(agent, target)`：会话范围；`target` 可为 `RUN-…`、`MAA-…`、`WFR-…`；所有权 `self / other / foreign / orphan`（`runOwnership`）。本进程持有 → 记录 `stop_now` 指令、abort、再次 kill、最多等 `DSH_MAA_STOP_TIMEOUT_MS`（默认 30 秒）；超时 → `clearRunStopping` + `stop_failed`。孤儿 → `stopRun` 按 pid 清理。同一 run 的并发停止共享一个 Promise。
  - `/maa confirm` 拆成 `confirmPlan` / `confirmPlanSteps`，在 `launches`（按会话）登记启动中的确认；各 await 之后检查 abort；启动阶段被停止且尚未消费 → 同时取消计划；已消费 → `executeDocument` 入口拒绝启动或通过 `abortSignal` 联动停止。**启动阶段在所有会话间串行**（`launchQueue`），避免两个会话同时通过“无运行”检查后输家确认码被白白消费。
  - `/maa status` 改为会话视角：`running/interrupted` 带 `owner`，并返回 `launching`（本会话启动中的确认）与 `pending`（本会话待确认计划的确认码）。
  - `/maa cancel`：已失效码幂等成功；已确认码返回“已经确认并开始执行（RUN-…）”；取消目标工作流计划时把工作流/目标置为 cancelled。
  - 运行时指令：`stop_now` 走 `stopExecution`；其他修改型指令拒绝非所有者会话；`maa_runtime_instruction` 工具传入 `exec.agent`。
  - 重启审计：遍历所有 `running` 记录，跳过 `foreign`，其余按 pid 清理并结算为“DSH 重启后已终止残留任务”。
  - 工作流登记 `sessionKey`、`confirmationCode`、`done`；步骤运行记录带确认码。
- `src/commands/local-command.js`：`/maa stop [RUN-…|MAA-…|WFR-…]`。
- `src/client/index.js`：
  - 每会话一个模块级 `createRunStore`（`dsh.maa.run:<sessionId>`），阶段 `launching / running / stopping / finished / observer`；`applyRunSnapshot` 用主机状态对账；`startConfirmation`（工具卡与确认条共用，成功=已开始）、`requestRunStop`（带目标、`inFlight` 防重复点击、失败保留按钮与原因）、`loadRunStatus`、`restorePendingPlan`。
  - `DockShell`：所有确认条状态共用外壳，标题栏始终有「−/+」与「×」，主体用 `hidden` 隐藏而**不卸载**；折叠状态按确认码持久化。计划 store 增加 `setError`、`setPreview`（备注预览挂在计划上）和按确认码的参数草稿（`dsh.maa.draft:<code>`）。
  - 运行面板：「停止任务」+「刷新状态」+ 运行时输入；「×」= 弹窗确认后停止；其他会话的运行显示为只读 observer（「×」只隐藏）；执行记录「×」只隐藏。工具卡在计划被消费后仍显示自己运行的停止按钮。
  - 仍然**不轮询**：只在挂载、用户操作、展开运行面板、点“刷新状态”时读一次 `/maa status`。

### 测试

- 新增 `test/panel-lifecycle.test.mjs`（10 项）：子进程加载真实 `src/index.js` 作主机（`test/fixtures/dsh-host.mjs`），`test/fixtures/fake-maa.mjs` 作 maa-cli（`fast / slow / escape` 模式，产生真实子进程树），`test/helpers/mini-react.mjs`（遵循 React 挂载/卸载与 `useSyncExternalStore` 重新订阅规则的极简渲染器）渲染真实客户端并点击。覆盖：确认→运行面板→停止→进程树真实退出；确认/运行面板 3 轮折叠展开且 `ConfirmButton` 不重挂载、刷新后折叠状态和草稿恢复；取消后确认码永久失效（含主机重启后）；关闭运行面板真实停止；并发确认/取消、重复停止/关闭、启动中停止；刷新、其他会话只读不可停、主机 SIGKILL 重启后按 pid 回收；停止超时保留控制并可重试（POSIX）；运行时自然语言指令；工具卡确认后两处都能停止；两个会话同时确认。
- 新增 `test/confirmation-lifecycle.test.mjs`（5 项），扩充 `test/run-state.test.mjs`（+4 项，含 `stopping` 回归）。
- 当前 Linux 工作区：`node --test test/*.test.mjs` → 204 项，191 通过、3 跳过（Windows 专用）、10 失败。这 10 项在**未修改的原始代码**上同样失败，原因都是环境：Windows 路径断言（2）、需要本机私有 MAA 运行时（4）、`.cmd` 假程序/`cmd.exe`（4）。把 `DSH_MAA_CLI_PATH` 指向 fake-maa 后，`runner.test.mjs` 中的主机测试在新代码上通过（原始代码同条件下仍失败），剩下的只缺 MAA 资源文件 `item_index.json`。生命周期测试连续多次运行稳定。
- **未在 Windows 上运行任何测试，未连接模拟器，未执行真实 MAA 任务。** `panel-lifecycle` 的 Windows 分支（`.cmd` 包装 fake-maa、`taskkill /T`、PowerShell pid 回收脚本）没有被执行过；第 7 项（进程逃逸）只在 POSIX 运行。

### 遗留限制 / 下一步

1. 请在 Windows 上先跑 `npm test`，重点看 `panel-lifecycle` 与 `run-state` 的 Windows 分支；`reapRunProcessTree` 的 PowerShell 脚本只做过代码审查。
2. 实机：重启 DSH Desktop 后按 README/汇报里的步骤验收。
3. 不轮询意味着任务自然结束后，运行面板要等用户展开/刷新/点停止才会显示“已结束”。若 DSH 将来提供服务端→客户端事件，可在任务结算时推送。
4. 孤儿记录（本插件进程已不持有）任何会话都可以停止，因为它已经没有所有者；另一个仍存活的 DSH 进程持有的记录不会被碰。
5. 工作流在两个步骤之间没有运行记录时，面板会短暂显示为结束；工作流本身的停止仍按确认码生效。


## 阶段 14：MAA 功能补全与养成规划扩展（已完成，未实机验证）

> 2026-10-31。依据 `claude/prompt-feature-1-2.md`。未修改版本号，未提交、未推送、未发布。代码在云端工作区编辑和测试，通过文件桥直接写回 `E:\DESK\dsh-maa-cli`；没有在本机 Windows 上运行命令。

### 现状核对
- 读取本机 `E:\DESK\MAA-v6.18.0-win-x64\resource`：`stages.json` 只有 `apCost / code / dropInfos / stageId`，**没有 `zoneId`**，因此周常关卡分区改为取自企鹅物流关卡列表；`item_index.json` 物品名（固源岩组=30013、模组数据块=mod_unlock_token 等）、`battle_data.json` 干员结构、`custom_infrast` 排班格式与实现一致。
- 外部接口按官方文档核对：MaaCore 集成协议（Fight.drops、Infrast filename/plan_index、Copilot copilot_list / formation / use_sanity_potion、SSSCopilot）、基建排班协议、MaaBackendCenter `copilot/query`（level_keyword/page/limit/order_by/desc）与 `copilot/get/{id}`、ArkPlanner `POST /plan`（owned/required/output_lang=id）。**均未在本机实际请求验证。**

### 改动
- `src/agent/http.js`：共用 `fetchJson`（超时、大小上限、SHA-256、POST）。`src/runtime/state.js`：共用 `writeJsonAtomically`。
- `src/agent/planning-data.js` v2：技能 / 专精（character_table）、模组（uniequip_table）、加工站配方（building_data F_EVOLVE）、周常开放日（zone_table weeklyAdditionInfos）、关卡分区（企鹅物流 stages）；`expandSynthesis`、`weeklyStageSchedule`、`serverWeekday`、`planWithArkPlanner`、`applyJointPlan`、`mergeRequirements`。
- `src/commands/planner.js`：Fight `drops`、剿灭别名、`@` 关卡名；Infrast mode 10000（只接受插件生成文件标记）；Copilot / SSSCopilot 步骤；公招摘要标明高星确认。
- `src/strategy/compiler.js`：`generatedFileMarker` / `materializeGeneratedFiles`，导出 `loadOperatorNames`。
- 新增 `src/strategy/infrast-plan.js`、`src/strategy/copilot-site.js`。
- `src/commands/runtime-instructions.js`：公招回调记录与 `recruitNotices`。
- `src/commands/task-panel.js`：Fight 掉落目标字段（list 类型，客户端无需改动），面板上下文携带物品索引。
- `src/agent/goal-manager.js`：多干员、技能 / 专精 / 模组、合成展开、ArkPlanner 联合规划与回退；导出 `trainingRequirements`。
- `src/index.js`：新工具 `maa_stage_schedule`、`maa_prepare_infrast`、`maa_copilot`；`maa_goal_manager` 新参数与 `estimate`；生成文件在执行时写入、结束时删除；公招提醒写入运行结论。
- `src/client/index.js`：新工具接入确认卡；运行进度对非肉鸽任务不再显示“局数 / 楼层”，并显示公招提醒。

### 测试
- Linux 云端工作区 `npm test`：217 项，203 通过、3 跳过、11 失败。失败项与改动前完全相同（Windows 路径、需要私有运行时、`.cmd` / `cmd.exe`），其中 `panel-lifecycle` 第 6 项在改动前后都偶发失败。新增 13 项全部通过。
- **未在 Windows 上运行测试，未连接模拟器，未执行真实 MAA 任务，未实际请求作业站 / ArkPlanner / 企鹅物流关卡列表。**

### 需要实机验证
1. 在 Windows 上运行 `npm test`。
2. 重启 DSH Desktop 后：`maa_stage_schedule`（首次会下载新增数据）、`/maa fight` 面板掉落目标、`maa_prepare_infrast` 生成排班并执行、`maa_copilot search/prepare` 实际请求作业站并执行一份作业、公招高星提醒是否出现在运行面板。
3. ArkPlanner 若长期不可用，规划会一直显示“未联合优化”，属预期回退。


### 阶段 14 补充：多步骤计划没有确认按钮（实机反馈修复）
- 现象：“帮我进行基建换班和公招”生成 2 步计划后，卡片一直显示“正在读取当前 MAA 能力…”，没有确认按钮。
- 根因（改动前就存在）：`taskPanelFromDocument` 只为单任务计划生成参数面板，多步骤计划和没有面板的任务类型（Copilot / SSSCopilot）返回 `null`；客户端拿到 `panel: null` 后不创建确认条。
- 修复：`/maa peek` 在没有可编辑面板时返回只读的 `Plan` 面板（无字段，列出每一步），确认时不提交任何参数覆盖，执行的就是准备好的计划。新增测试覆盖。
- 同时在 `maa_prepare_plan` 说明中写明 `Recruit.times=0` 只识别不招募，用户要求公招时默认 4 次。

### 阶段 14 补充二：自检后修复（2026-10-31）
- 公招：MaaCore 文档写明 `confirm` 为空数组表示只计算，原默认 `confirm: []`、`times: 0` 导致“公招”从不招募。改为默认 `times: 4`、`confirm: [3, 4]`，摘要按实际参数说明；面板默认值同步。
- 周常开放日：直接下载 cn `zone_table.json` 核对，真实字段为 `weeklyAdditionInfo`（daysOfWeek + EVOLVE/MATERIAL/SPECIAL），原代码读错字段。企鹅物流 zones 接口把全部芯片本归为 `weekly_1`「芯片搜索」，与游戏 `weekly_1`「固若金汤」(PR-A) 冲突，改用 `stage_table.json`（约 26 MB，单独 96 MB 上限）。缓存 v3。`test/fixtures/weekly-stages.json` 为真实表与本机 MAA v6.18 `stages.json` 的周常摘录。
- 面板记忆：不再保存插件生成文件（以及对应的 Infrast 自定义模式 / 方案序号）和掉落目标；读取旧记忆时也忽略这些值。执行前 `assertNoGeneratedMarkers` 拒绝残留占位。
- 作业站：技能所需精英化纳入练度判断；排班：按 Box 缓存提示未拥有的干员（不阻止确认）。
- Linux `npm test`：221 项，207 通过、3 跳过、11 失败（与改动前相同的环境性失败）。

### 阶段 14 补充三：第二次自检后修复（2026-11-01）
- 自然语言计划被面板记忆覆盖（改动前已存在）：`maa_prepare_plan` 等模型工具准备的计划不登记 `panelExplicitKeys`，`/maa peek` 把 `panel-memory.json` 叠加到计划上，确认时以记忆值执行（复现：记忆 CE-6×5，计划 1-7×20 → 面板显示并执行 CE-6×5）。现在这些计划带 `panelMemory: false`，peek 不套用记忆。
- ArkPlanner 成功时 `materialPlan` 读取 `drop.rate.toFixed` 崩溃（本阶段引入）；新增 `dropFact` 与成功路径测试。
- 旧版公招记忆（times 0 + confirm []）在读取时忽略。
- 代理倍率：MaaCore 文档 series 为 -1～6；原逻辑次数 7～10 传 7～10。现在一律 `series: 0`，面板移除倍率字段，面板确认时强制 0；目标工作流同样。
- 合成展开只展开 item_index rarity ≥ 3（紫/金）的材料；ArkPlanner 使用未展开的需求。真实数据：2×RMA70-24 → 蓝色材料，而非 60 源岩。
- 模组：读取 `unlockEvolvePhase` / `unlockLevel`（真实数据银灰 X 模组 PHASE_2 / 60）。缓存 v4。
- 条件下载：`fetchJson` 支持 If-None-Match / If-Modified-Since；raw.githubusercontent 已实测返回 304。
- 验证：用真实 cn 游戏表（character / gamedata_const / uniequip / building / zone / stage）跑插件数据加载，无警告；1403 名干员、508 个模组、39 条加工配方、35 个周常关卡。
- Linux `npm test`：226 项，213 通过、3 跳过、10 失败（均为改动前已有的环境性失败）。未实机运行。

## 阶段 15：1.0.8 发布准备（2026-11-01）
- `package.json` 版本 1.0.6 → 1.0.8（npm 上最新为 1.0.6，1.0.7 从未发布）。
- CHANGELOG：把“未发布”整理为 `1.0.8 - 2026-11-01`。对照已发布的 1.0.6 包，原“未发布”中已随 1.0.5 / 1.0.6 发出的条目补记为 `1.0.5 / 1.0.6 - 2026-10-30`；1.0.6 包中没有的面板停止 / 最小化修复归入 1.0.8。同一版本内新功能的中间修复合并进功能描述。
- `npm pack --dry-run`：36 个文件，211,351 B（解包 709,705 B），包含新增的 `src/agent/http.js`、`src/strategy/copilot-site.js`、`src/strategy/infrast-plan.js`，不含测试、交接文档和 `artifacts/`。实际打包到临时目录并从包内加载入口，15 个工具注册成功、客户端可解析；未生成仓库内 tgz。
- 全量测试同阶段 14 补充三（Linux 226 项：213 通过、3 跳过、10 个既有环境性失败）。
- 未执行 git 提交、打 tag、推送或 npm 发布，留给用户执行。

## 阶段 16：1.0.9 发布准备（2026-11-02）
- 1.0.8 发布时测试 6（panel-lifecycle）因未等待 fake maa 写入进程记录而失败，补等待后通过；`npm publish` 因 npm 未登录 404，用户登录后已补发 1.0.8。
- 版本查询测试不再写死 MaaCore 版本号（本机运行时每日自动更新，v6.20.1 → v6.21.1 后失败）。
- 运行面板新增等待提示：MaaCore 每日自动更新、首次安装运行时、MaaCore 启动并连接模拟器（第一个 TaskChainStart 后清除）。
- 新增桌面通知（`src/runtime/notify.js`）：任务完成 / 失败 / 按条件停止、自动换作业；手动停止不通知；`DSH_MAA_NOTIFY=0` 关闭，`node --test` 下自动关闭。面板不轮询，所以由插件进程通知。
- 抄作业失败自动换作业：准备时挑最多 3 份同关、同类型、Box 不缺干员的备用作业；只在作业本身失败时换（ADB / 截图 / 初始化 / 资源 / 手动停止不算），不占用通用重试次数。仅限 MAA 导航到关卡的 Copilot。
- `package.json` 1.0.8 → 1.0.9，CHANGELOG「未发布」整理为 `1.0.9 - 2026-11-02`。
- 偶发失败查明并修复：(1) runner.test 斜杠命令测试只给 2 秒 AbortSignal，并行负载下准备 fight 计划超时返回 error（失败耗时均约 2.0–2.8 秒；1 ms 超时可复现同样的 error），改为 20 秒；(2) 停止成功后客户端切到 finished 但仍显示停止前的记录「执行中」，现在立即把本地记录标为 stopped，再异步重读状态。
- Windows `npm test`：231 项，229 通过、2 跳过、0 失败；修复后全量连续 8 次全部通过。
- `npm pack`：37 个文件，217.2 kB（解包 731.5 kB），含 `src/runtime/notify.js`，不含测试。从包内加载入口：15 个工具、1 个命令注册成功，客户端可解析。
- 换作业流程未在真实游戏中验证。未执行 git 提交、打 tag、推送或 npm 发布，留给用户执行。

## 阶段 17：1.1.0 发布准备（2026-11-02）
- issue #1（`/maa status` 回显进对话、面板不自动刷新）：DSH 每条命令都会写入 command/run + command/done，没有静默选项。插件在 `ctx.inject(['connection','webServer'])` 中用 `webServer.register` 注册前缀路由 `/dsh-maa-cli`，按 Connection RPC 线格式应答（`client-request` → `server-response`），鉴权交给 `connection.requestRejection`；客户端在 inject 中声明 `connection`，用 `connection.rpc.call('/dsh-maa-cli','status',{session})` 读取。运行中每 3 秒后台刷新；无频道时退回 `/maa status`，每会话只在首次挂载时读一次。
- 不用 `connection.rpc.handle`：真实 DSH 主机上第三方插件调用会报 `cannot get property "webServer" without inject`（rpc.handle 用 Connection 自己的上下文访问 webServer）。最初的绝对路径 `fetch` 方案同样没有在真机上验证就交付，属失误。
- 面板被误关闭：`readRunState` 把任何读取错误当成空记录，`mutateRunState` 还会把空记录写回。现在 ENOENT 才算空，EACCES/EBUSY/EPERM 与 JSON 解析失败重试后报错；写入只做原子 rename 并有限次重试；客户端不因一次不含当前任务的快照关闭带 runId 的运行面板。
- 诊断：`status-rpc.json` 记录 applied → registered / register-failed / inject-failed；客户端退回命令时在控制台打印原因。
- 真机验证：临时 `DSH_HOME` 下以 web 模板建配置、链接本仓库、启动真实 DSH 主机（假 maa-cli）：注册成功；无 cookie 401、跨站 403、带 cookie 200；在真实网页中按 rpc.call 方式请求返回 200 且 rpcId 匹配。用户桌面版重启后 `status-rpc.json` 为 registered，实测刷新不再回显、面板自动更新、结束后自动变为已结束。
- 日志跟踪：`startLogTail().flush()` 在定时读取进行中时直接返回（`polling` 标志），任务结束时可能漏读最后的 MaaCore 回调；全量测试偶发失败暴露了它。改为共享进行中的读取 Promise，flush 先等它再读一次；新增可稳定复现的回归测试（旧代码只读到 first）。
- 文档：README 精简并拆分到 `docs/`，新增 `README.en.md` 与 `docs/en/`。
- Windows `npm test`：237 项，235 通过、2 跳过、0 失败，连续 4 次全过。`npm pack`：39 个文件，208.9 kB（解包 709.0 kB），含 `src/commands/status-rpc.js` 与 `README.en.md`，不含测试；从包内加载入口 15 个工具、1 个命令，并请求注入 connection/webServer，客户端可解析。
- `package.json` 1.0.9 → 1.1.0，CHANGELOG「未发布」整理为 `1.1.0 - 2026-11-02`。
- 未执行 git 提交、打 tag、推送或 npm 发布，留给用户执行。

## 阶段 18：交接文档更新、服务端拆分、黑流树海排查（2026-11-03）
> 未修改版本号，未提交、未推送、未发布。全部在本机 Windows 上进行。

### 第 8 项：交接文档
- `AGENT_HANDOFF.md` 停留在 1.0.2（148 项测试、HEAD `3ac09e8`、「后台执行未实机验证」等），逐条对照代码与阶段 1–17 改写为当前快照：项目与环境、目录职责、能力状态四表（已实机 / 未实机 / 有意不做 / 未实现，均注明阶段号或 `RUN-…`）、已知问题、关键机制、测试与真实 DSH 验证步骤、发布要点。去掉 git HEAD、diffstat 等易过时信息。
- 已过时并更正的条目：`STALE_MS` 是 7 小时而非 40 分钟；面板记忆覆盖所有 `/maa` 面板（v2）而非仅肉鸽；客户端经静默频道每 3 秒刷新，不再「不轮询」；堵门 / 守蓝门各存一条跨地图策略；萨米 `_collapse` 关卡是因地图数据缺失列为不支持，代码中没有专门的跳过逻辑。
- `docs/HANDOFF.md` 是 0.9.2 时期的另一份交接记录（94 项测试），未删除未改写，开头加「已过时」提示并指向 `AGENT_HANDOFF.md`。
- **基线更正**：阶段 17 记录的「237 项、235 通过」有误，实际为 239 项、237 通过、2 跳过（当时只看了通过数）。与阶段 17 最后一次运行逐项对比，测试列表完全一致。

### 第 9 项：拆分 `src/index.js`
- 客户端不拆：`dsh-client-modules` 每个插件只读取 `exports["./client"]` 指向的一个文件，传给 factory 的 `require` 只解析包名、不解析相对路径（源码注释提到构建期打包检查）。临时 DSH 主机实测：页面为插件加载 `plugins/??dsh-maa-cli/client.js`，内容与 `src/client/index.js` 逐字一致、只有一个模块注册。多文件需要构建步骤，按约束保持单文件。
- 服务端：新增 `src/host/`（`execution-state`、`maa-command`、`confirm`、`run-control`、`execution`、`goal-workflow`、`plan-environment`、`formatting`、`tool-schemas`、`tools/status-tools`、`tools/planning-tools`、`tools/feature-tools`、`tools/runtime-tools`）与 `src/runtime/maa-cli.js`；`src/index.js` 从 155.5 KB 降到 2.9 KB，只保留 `name` / `inject` / `apply`、status 频道注册与重新导出。
- 共享状态：五个 `Map` 只在 `execution-state.js`；会被重新赋值的 `let` 各自只有一个使用者，原样留在使用模块（`launchQueue` → `maa-command`，`activeStrategyExecution` → `execution`，`runtimeBootstrapPromise` → `runtime/maa-cli`，`restartRecoveryPromise` → 入口），未改任何逻辑。
- 方法：脚本按声明名原样搬移（含上方注释），只给搬走的声明加 `export`，import 按实际用到的标识符生成。第一版脚本有两个缺陷，已在测试前由核对发现并重做：去除模板字符串的正则会吞掉两段模板之间的代码，导致漏 import；按括号计数找函数结尾会被正则字面量打乱，截断了 `classifyMaaExecution`。改为保留模板字符串、以列 0 的 `}` 判定结尾。
- 核对：原文件每一行在新文件中恰好出现一次（仅多出 5 个注册包装函数的结尾括号）；无漏 import、无多余 import；导入图 45 个模块无循环，`src/commands`、`src/agent` 等不引用 `src/host`；拆分前后 15 个工具的完整定义（名称、说明、参数与输出 schema）、`/maa` 命令定义、入口导出集合完全一致。
- 测试：唯一需要调整的是 `feature-tools.test.mjs` 中读取源码查找「公招提醒：」的路径（`src/index.js` → `src/host/execution.js`），断言未改。Windows `npm test`：239 项，237 通过、2 跳过、0 失败，连续 3 次。
- 打包：`npm pack --dry-run` 53 个文件，213.5 kB（解包 718.6 kB），含全部新文件，不含测试、交接文档和 `artifacts/`；打包到临时目录并从包内加载入口：15 个工具、1 个命令，请求注入 connection / webServer，客户端可解析。仓库内未生成 tgz。
- 真实 DSH 主机（临时 `DSH_HOME`，web 模板，假 maa-cli）：`status-rpc.json` 为 registered，主机日志无错误，频道请求 200；真实页面加载的客户端与源文件一致，样式表 `dsh-maa-cli-styles` 已注入，控制台无错误。临时 web 界面新建会话需要登录 DeepSeek，确认面板与运行面板的渲染、确认、停止**未在真实页面验证**，需用户在桌面版确认（客户端代码未改动）。

### 第 11 项：黑流树海 `U1T` 难度文本（只读排查）
- 运行时 `asst.log` 中 `Failed to convert difficulty text` 只出现 1 次：2026-10-30 15:56:46，MaaCore v6.20.1。此后没有黑流树海运行，MaaCore 已更新到 v6.21.1；`runs.json` 最近 8 条无肉鸽记录。按约定标为「未复现，需要用户实机确认」，未改代码。
- 日志表明旧结论有误：难度 OCR 失败不致命（`Current difficulty: -1` 后照常确认、选分队、寻路）；真正的失败在 1 分 48 秒后，`NodeDispatchAction` 连续 20 次识别不到 `StageTraderInvestSystem`，`SubTaskError`（`pre_task: RoutingAction`）→ `TaskChainError`。MaaCore 确认收到的参数（BlackFlow / mode 0 / difficulty 0 / 特勤分队 / 稳扎稳打 / 机械师）都在能力层范围内，调试截图显示第一层地图已被正常识别。判断为 MaaCore 侧界面识别问题，插件不做绕过。复现步骤与需回传的日志片段写在 `AGENT_HANDOFF.md` 第 4 节。

### 未实机验证
1. 拆分后在 DSH 桌面版中完成一次「准备计划 → 确认 → 运行面板 → 停止 / 自然结束」。
2. 黑流树海复现（见交接文档）。
