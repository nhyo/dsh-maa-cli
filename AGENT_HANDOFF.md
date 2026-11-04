# AGENT HANDOFF — dsh-maa-cli

> 当前状态快照（对应 `package.json` 1.1.0）。只写接手时需要知道的事；开发历史在 `AGENT_PROGRESS.md`（阶段 1–17）。
> 不写 git HEAD、diffstat 这类很快过时的信息：需要时运行 `git status` / `git log -1`。

## 1. 项目

DSH Desktop 插件：用自然语言或零模型的 `/maa` 命令准备《明日方舟》MAA 任务，由用户确认后通过插件私有的 maa-cli 运行时在后台执行，并提供运行控制、目标与养成规划。Node ≥ 22，ESM，无构建步骤，无第三方依赖。

- 仓库：`E:\DESK\dsh-maa-cli`。用户的 DSH 桌面配置以 `link:E:/DESK/dsh-maa-cli` 直接加载本目录：改了主机代码必须**彻底退出 DSH（含托盘）再打开**才生效；客户端脚本每次按 no-store 重新加载。
- 插件私有运行时：`%USERPROFILE%\.dsh\maa-cli\runtime`（maa-cli、MaaCore、resource、日志 `state\debug\asst.log`），通过四个 `MAA_*_DIR` 与系统 MAA 隔离。
- 插件状态目录：`%USERPROFILE%\.dsh\maa-cli`（`DSH_MAA_CLI_STATE_DIR` 可改）：`runs.json`、`pending-plans.json`、`panel-memory.json`、`strategy-memory.json`、`operator-box.json`、`depot.json`、`goals.json`、`workflows.json`、`planning-data.json`、`status-rpc.json` 等。
- `E:\DESK\MAA-v6.18.0-win-x64` 是用户自己的 MAA GUI，插件不启动它；核对 MAA 资源时以运行时实际使用的 `runtime\data\resource` 为准。

## 2. 目录与模块职责

| 路径 | 职责 |
| --- | --- |
| `src/index.js` | 服务端入口：`name` / `inject` / `apply`；启动重启审计、注册 status 频道，再按原顺序调用各注册函数；重新导出测试与旧调用方用到的内部函数 |
| `src/host/execution-state.js` | 进程内共享状态的唯一持有者：`activeExecutions`、`activeRuns`、`activeWorkflows`、`stopRequests`、`launches`，以及 `agentKey` / `runOwnership` |
| `src/host/maa-command.js` | `/maa` 命令分发；持有启动队列 `launchQueue` |
| `src/host/confirm.js` | 确认流程 `confirmPlan` / `confirmPlanSteps` |
| `src/host/run-control.js` | 停止与所有权、会话状态快照、运行时指令、`assertNoActiveRun`、重启审计 |
| `src/host/execution.js` | 后台执行 `executeDocument`、恢复循环、生成文件写入与清理、自动换作业、结束通知；持有 `activeStrategyExecution` |
| `src/host/goal-workflow.js` | 目标规划与工作流执行入口 |
| `src/host/plan-environment.js` | 准备计划时的能力、策略记忆与备注预览上下文 |
| `src/host/formatting.js` | 命令结果、停止结果与执行反馈的文本 |
| `src/host/tool-schemas.js` | 工具结果 schema 与渲染函数 |
| `src/host/tools/*.js` | 15 个工具的注册，按原顺序分 4 组：`status-tools`、`planning-tools`、`feature-tools`、`runtime-tools` |
| `src/client/index.js` | 客户端（浏览器）入口，**必须保持单文件**：DSH 只加载 `exports["./client"]` 指向的一个文件，`require` 不解析相对路径（阶段 18 实测）。含确认条与运行面板、工具卡、运行 store 与对账、状态读取 |

依赖方向：`src/index.js` → `src/host/tools/*`、`maa-command` → `confirm` → `goal-workflow` → `execution`；`run-control`、`plan-environment`、`formatting`、`tool-schemas` → `execution-state`。`src/commands`、`src/agent` 等不反向引用 `src/host`，无循环依赖。
| `src/commands/` | `/maa` 解析（`local-command`）、任务规划（`planner`）、参数面板（`task-panel`）、面板记忆、确认码（`confirmation`）、运行记录（`run-state`）、运行时指令与日志跟踪（`runtime-instructions`）、status 频道（`status-rpc`） |
| `src/capabilities/` | 从当前 MAA 版本与资源发现能力（主题、模式、难度、分队等），带签名缓存 |
| `src/runtime/` | maa-cli 调用（`runner`）、确保 maa-cli 存在（`maa-cli`）、私有运行时安装与更新（`runtime`）、路径（`paths`）、状态目录（`state`）、模拟器预检、体检（`doctor`）、桌面通知（`notify`） |
| `src/operators/` | 干员 Box、仓库、培养建议（**培养排序只在 `training-advice.js`**） |
| `src/agent/` | 目标、工作流、养成数据与掉率、联网请求、故障诊断与恢复决策 |
| `src/strategy/` | 策略编译与原子记忆、肉鸽资源覆盖、Copilot 生成、基建排班、作业站客户端 |
| `test/` | 全部测试；`fixtures/fake-maa.mjs` 充当 maa-cli，`fixtures/dsh-host.mjs` 充当 DSH 主机，`helpers/mini-react.mjs` 渲染真实客户端 |
| `docs/` | 用户文档（中文）与 `docs/en/`（英文）；`docs/HANDOFF.md` 是 0.9.2 时代的旧交接记录，已过时 |
| `artifacts/` | 本地旧打包文件，不随 npm 发布 |

## 3. 能力状态

依据一栏：阶段号指 `AGENT_PROGRESS.md`，`RUN-…` 是用户实机运行记录。

### 已实现且实机验证

| 能力 | 依据 |
| --- | --- |
| 后台执行（确认后立即返回，进程归插件持有） | RUN-0CAC2582 等 StartUp+OperBox、RUN-A8D75CD2 公招均正常结束 |
| 停止任务、DSH 重启后回收残留进程 | RUN-45FB4BC9（手动停止）、RUN-2AA95400（重启后结算） |
| 运行时指令「本局结束后停止」「立即停止」 | RUN-CF8D26A8（JieGarden，结算 1 局后停止）、RUN-62293C34（阶段 16 前的用户记录，已滚出 `runs.json`） |
| 静默 status 频道、面板每 3 秒自动刷新、结束后自动变为已结束 | 阶段 17，用户桌面版实测 |
| 运行时自动更新与等待提示 | 阶段 16（实机出现过约 1 分钟的 MaaCore 更新） |
| 桌面通知（Windows Toast） | 阶段 16 测试通知实机弹出 |
| 公招默认只确认 3★/4★ | 阶段 14 补充二，RUN-9C2BF593 / RUN-A8D75CD2 |
| 干员 Box 扫描与培养建议 | RUN-0CAC2582（用户发起，用于培养建议） |

### 已实现但未实机验证

| 能力 | 依据（自动化测试） |
| --- | --- |
| 抄作业按 Box 排序、失败自动换作业（最多 3 份） | 阶段 14、16；`feature-tools`、`copilot-fallback` |
| 自然语言基建自定义排班（mode 10000） | 阶段 14；`feature-tools` |
| 掉落目标、今日开放关卡 `maa_stage_schedule` | 阶段 14；`feature-tools`、`planning-data` |
| 目标与工作流、养成规划（技能 / 专精 / 模组、ArkPlanner） | 阶段 8、10、14；`goal-manager`、`workflow-manager`、`planning-data` |
| 仓库扫描 `DepotInfo` 与有限自动重试 | 阶段 6–7；`depot`、`recovery-manager` |
| 备注编译、全关卡自动选点、招募表补分组 | 阶段 1–3 前；`strategy-*` |
| 「再打 N 局」「Boss 前停止」 | 阶段 2、11；`runtime-instructions`（真实日志抽样解析通过，触发未实机） |
| 面板记忆（所有 `/maa` 面板，v2） | 阶段 12；`panel-memory` |

### 有意不做

| 能力 | 原因 |
| --- | --- |
| 运行中修改招募偏好、人工接管下一场战斗 | maa-cli 子进程不暴露 `AsstSetTaskParams` / 暂停接口；明确返回 `unsupported`，不改配置冒充生效（阶段 1） |
| 暂停 / 继续 | MaaCore 没有可靠的暂停 |
| 策略记忆管理面板 | 已下线，后端命令保留给模型（`/maa strategies` 等） |
| 消耗类任务（作战、公招、商店、领奖、基建）自动重试 | 可能重复消耗（阶段 6–7） |
| 插件绕过 MaaCore 识别问题（伪造难度、改 MaaCore 资源） | 见第 4 节 |

### 未实现

- 多关连推（一次确认推多关）：用户暂缓。
- 定时每日任务、理智规划、Box / 仓库历史快照：只在讨论中提出过，未开始。
- 运行面板的「最近执行」列表：`/maa status` 返回 `recent`，界面只显示最近一条。

## 4. 已知问题与限制

1. **黑流树海肉鸽失败：未复现，需要用户实机确认**（阶段 18 只读排查）。
   - **只出现过一次**：2026-10-30 15:56–15:58，MaaCore v6.20.1，计划为 `BlackFlow / mode 0 / difficulty 0 / 特勤分队 / 稳扎稳打 / 机械师`。之后 `asst.log` 中再没有黑流树海运行，MaaCore 已自动更新到 v6.21.1（2026-11-01 起），`runs.json` 中也没有近期肉鸽记录。
   - **旧结论有误**：`Failed to convert difficulty text to number. Text = U1T` 是 MaaCore 用 OCR 读难度界面上一块 21×8 像素的文字失败（置信度 0.71）。它**不致命**：MaaCore 记为 `Current difficulty: -1`，随后照常确认、选分队、进入第一层并完成寻路。**真正的失败在 1 分 48 秒后**：`BlackFlow@Roguelike@NodeDispatchAction` 连续 20 次没识别出 `BlackFlow@Roguelike@StageTraderInvestSystem`，报 `SubTaskError`（`pre_task: BlackFlow@Roguelike@RoutingAction`），任务链 `TaskChainError`。旧文档把相隔近 2 分钟的两件事连在了一起。
   - **判断：两处都属于 MaaCore 侧的界面识别**，与插件参数无关。依据：MaaCore 日志确认收到 `Roguelike theme BlackFlow | mode 0 | difficulty 0`，并按这些参数完成了难度确认、选分队和寻路；参数都在能力层 `BlackFlow` 描述的范围内（难度 0–16，`src/capabilities/discovery.js`）；MaaCore 15:58:12 的调试截图 `runtime\state\debug\BlackFlow\BF-A2-1\overlay.png` 显示第一层地图已被正常识别和标注。插件不做绕过（不伪造难度、不改 MaaCore 资源）。
   - **用户复现步骤**：
     1. 彻底退出并重启 DSH，启动模拟器，进入游戏主界面。
     2. 输入 `/maa rouge 黑流树海`，在面板里把「刷取次数」设为 1。先用默认难度「MAX（当前最高）」跑一次；如需对照，再把难度改为 0 跑一次（与 10-30 那次相同）。
     3. 确认执行后，在运行面板输入「本局结束后停止」。让它跑到本局结算或任务报错为止，不需要中途手动停止。
     4. 在 PowerShell 中提取日志：
        ```powershell
        $log = "$env:USERPROFILE\.dsh\maa-cli\runtime\state\debug\asst.log"
        Select-String -Path $log -Pattern 'Version v','Roguelike theme','Detected difficulty text','Failed to convert difficulty','Target difficulty','Current difficulty','SubTaskError','TaskChainError' | Select-Object -Last 30
        Select-String -Path $log -Pattern 'SubTaskError' -Context 40,0 | Select-Object -Last 1
        ```
        连同 `runtime\state\debug\BlackFlow\` 下最新的截图一起回传。
     5. 判读：只有 `Failed to convert difficulty` 而任务继续，属 MaaCore 难度 OCR 的已知瑕疵，可在游戏里先手动切到目标难度再运行；出现 `NodeDispatchAction` / `StageTraderInvestSystem` 一类 `SubTaskError` 时，属 MaaCore 识别问题，应附上述日志片段和截图反馈给 MAA 上游。
2. 黑流树海上游只有 1 个原生 autopilot 关卡（`暗箭难防`），「全关卡堵门」对它等于单关。
3. 萨米的 `_collapse` 变体关卡在 `Arknights-Tile-Pos` 中没有条目，自动选点时列为不支持（不做后缀剥离）。
4. 招募表补的分组优先级固定为 2000 / 2000；备注不支持给单个干员指定优先级（`maa_prepare_strategy` 的 `priority` 可以）。
5. 不要新增经过 `/maa` 命令的轮询：DSH 会把每条命令写进对话记录（issue #1）。客户端状态读取走 `/dsh-maa-cli` 频道，见第 5 节。
6. `connection.rpc.handle` 不能由第三方插件调用（会报 `cannot get property "webServer" without inject`），status 频道因此用 `webServer.register` 自己实现 RPC 线格式（阶段 17）。
7. 「MAA 进程已正常结束，但任务结果未完全验证」是 Box / 公招等任务的常见结论：进程正常退出不等于游戏目标达成。
8. 插件状态文件读取失败时报错而不是返回空记录（阶段 17）；如遇「runs.json is not valid JSON」，说明文件被外部写坏，需要人工检查。

## 5. 关键机制（改动前必读）

- **确认与执行分离**：模型工具只准备计划（`preparePendingPlan`），确认码单会话、一次性、30 分钟过期；执行只由 `/maa confirm`（面板按钮）触发。
- **状态读取**：客户端 `connection.rpc.call('/dsh-maa-cli', 'status', { session })` → 主机 `src/commands/status-rpc.js` 的路由（鉴权交给 `connection.requestRejection`）。没有该频道时才退回 `/maa status`，且每会话只在首次挂载时读一次。`status-rpc.json` 记录主机是否注册成功（`applied → registered / register-failed / inject-failed`）。
- **运行记录**：`runs.json` 串行原子写；读失败重试后报错，绝不当成空记录写回。运行面板不会因一次快照里缺少当前任务而关闭。
- **停止**：只终止本插件记录的进程树（命令行须含 `dsh-generated`）；其他会话只读。
- **生成文件**：排班 / 作业 / 肉鸽覆盖只在执行期间写入 maa-cli 配置目录，结束后删除或恢复。

## 6. 测试

- 全量：`npm test`（`node --test test/*.test.mjs`）。开发时只跑相关文件：`node --test test/xxx.test.mjs`。
- 当前基线（Windows）：**239 项，237 通过、2 跳过、0 失败**（阶段 17 记录的「237 项、235 通过」是当时漏看了总数，测试列表本身没有变化，见阶段 18）。跳过的 2 项是 POSIX 专用的进程测试。
- Linux 上有一批已知环境性失败（Windows 路径断言、需要本机私有运行时、`.cmd` / `cmd.exe`），与改动无关，要单独列出。
- 测试不连接模拟器、不执行真实 MAA：用 `test/fixtures/fake-maa.mjs`（`fast / slow / escape` 模式）和 mock 的 fetch。
- **主机侧改动要在真实 DSH 上验证**，不能只看单测（阶段 17 有过教训）：
  1. 设 `DSH_HOME` 为临时目录，运行 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd plugin --profile web add link:E:/DESK/dsh-maa-cli`；
  2. 设 `DSH_MAA_CLI_STATE_DIR` 为临时目录、`DSH_MAA_CLI_PATH` 为包装 fake-maa 的 `.cmd`、`FAKE_MAA_ROOT`、`DSH_MAA_NOTIFY=0`，运行 `dsh.cmd web --no-open --port 39123`；
  3. 读临时状态目录下的 `status-rpc.json`；用输出的 `/?token=…` 地址取得 cookie 后请求频道。
  桌面配置不能用命令行启动（只能由 Electron 应用加载）；临时 web 界面新建会话需要登录 DeepSeek，完整界面流程仍需用户实机确认。

## 7. 发布要点

**git 提交、打 tag、推送、`npm publish` 和修改版本号都由用户执行。** 代理只准备文件并给出命令。

1. `package.json` 的 `version` 与 CHANGELOG：把「未发布」整理为 `<版本> - <日期>`。
2. `npm test` 全过；`npm pack --dry-run` 检查文件列表：包含所有 `src/` 新文件、`README.md`、`README.en.md`、`CHANGELOG.md`；不含 `test/`、交接文档、`artifacts/`。需要实际打包时打到临时目录，解压后加载入口，确认 15 个工具、1 个命令注册成功并请求注入 `connection` / `webServer`，客户端可解析。
3. 给用户的发布命令用 `&&` 串联（任何一步失败就停），先确认 `npm whoami` 已登录：
   `npm test && git add <文件…> && git commit -m "release: <版本> …" && npm publish && git tag -a v<版本> -m "<版本>" && git push origin main --tags`
4. 提交信息和 PR 中不加任何署名。
