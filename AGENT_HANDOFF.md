# AGENT HANDOFF — dsh-maa-cli

> 生成时间：2026-10-30 18:52（本地）｜交接对象：GPT-5.6｜本文基于实际代码与 `git` 状态核对，不依赖对话记忆。

## 0. 环境与约束

- 项目：`E:\DESK\dsh-maa-cli`（DSH Desktop 插件，Node ≥ 22，ESM，无构建步骤）
- MAA GUI：`E:\DESK\MAA-v6.18.0-win-x64`（与本插件无关，插件不启动它）
- 插件私有 runtime：`%USERPROFILE%\.dsh\maa-cli\runtime`（maa-cli + MaaCore + resource 都在这里，`MAA_CONFIG_DIR` 被重定向）
- 关键外部资源：`runtime\data\resource`（`roguelike\`、`battle_data.json`、`Arknights-Tile-Pos\overview.json`）
- **禁止**：commit / push / npm publish（用户明确要求）。当前工作树全部保留，未提交。
- DSH 当前实例启动于 17:01:17，`src\index.js`(16:55:08)、`src\runtime\runner.js`(16:54:38) 都早于它，所以最新代码已加载；但**自后台执行改造后还没有任何一次真实 MAA 运行**（`runs.json` 最新记录停在 16:47–16:52）。

## 1. 本轮实际完成的内容

### 1.1 备注解析（自然语言 → 本地编译）
- 肉鸽招募动词扩展为 `招募|选择|选|拿|抓|捞|取`；支持 `并/并且/然后/同时` 多意图。
- 新增括号感知分句：`[3,1]` 里的逗号不再被当成分句符。
- 支持「有特种券则优先招募 X」这类前置资格短语（`^[有带存]…券` 剥离）与尾部「放置/部署/站位/就位」。
- 代词（他/她/它/该干员…）与虚词（来/去/就/也/再…）回退到最近一次招募的干员；无法回退时整句交回模型。
- 肉鸽战术支持「在暗箭难防让 X 堵门 [3,1] 朝下」形式（关卡名 + 坐标 + 朝向），保存为 `stageName/location/direction`。

### 1.2 新工具 `maa_prepare_note`
- 参数：`note`(必填)、`purpose`、`confirmationCode`、`theme`、`mode`。
- 流程：本地 `parseStrategyNote` → 若 `needsModel` 返回 `{status:'needs_model', unresolved, modelPrompt}`（不 `concludeTurn`，让模型追问）→ 否则 `compileStrategyRequest` → `applyStrategyMemory` → `previewStrategyDetails` → 生成待确认计划（`preparePendingPlan`，含 `notePreview`）。
- 修复过「计划串台」：早期用 `peekPendingPlan` 克隆会话最近计划，导致 BlackFlow 面板生成出 Phantom 计划；现按 `theme` 参数重建 document，并打印「按面板主题 X 重建任务」。
- `noteModelPrompt` 改为「先识别主语与动词 → 规范化备注 → 调 `maa_prepare_note`」，并附带确认码与主题。

### 1.3 肉鸽堵门 / 守蓝门 → autopilot 原生 `deploy_plan`
- 写入 `roguelike/<theme>/autopilot/<关卡>.json` 的 `deploy_plan`；保留 `replacement_home`、`blacklist_location`。
- 关卡按文件内 `stage_name` 匹配（文件名可不同），`findAutopilotFile`。
- 不写关卡名 = **全部原生 autopilot 关卡**：用 `Arknights-Tile-Pos/overview.json` → per-level `tiles[y][x].buildableType` 选点；`position==='RANGED'` 取高台(2)、`MELEE` 取地面(1)，朝向由路径推导。
- 缺地图/无可部署落点/干员无法分组的关卡逐条进入 `unsupported`，不伪造文件。
- 修的选点缺陷：`tile_forbidden` 上起点=终点的退化路线；落点在 `route[0]` 时朝向索引为 -1。

### 1.4 招募表缺失干员 → 合成最小合法分组
- `battle_data.json`（`chars` 以 charId 为键）校验干员真实存在。
- 合成 `{name, opers:[{name, skill:1, is_key:false, is_start:false, recruit_priority:2000, promote_priority:2000}]}`，并 `unshift` 进 `priority`。
- **重写整个 `recruitment.json`**（内置分组 + 新增），因为 MaaCore `RoguelikeRecruitConfig::parse` 会 `clear(theme)` 整体替换。
- 缺失 `battle_data.json` 或查不到干员 → 明确 `unsupported`（`missingOperatorReason`）。

### 1.5 确认面板
- 难度新增 `MAX`（显示「MAX（当前最高）」）并作为默认；确认时解析为该主题 `Math.max(difficulties)`；显式数字仍以数字为准。
- 备注解析成功后只显示「已收到并解析【备注】」+「尚未操作游戏…」；不再显示 supported/unsupported/changes/memory 明细。
- 策略记忆管理面板不再挂载（后端 `/maa strategies`、enable/disable/delete 保留给模型）。
- 备注切换主题时重建任务链，`/maa peek` 返回 `theme`，确认时改主题会写进摘要。
- 新增按主题的面板记忆 `panel-memory.json`：确认后记住模式/难度/次数/分队/职业组/开局干员/高级开关，下次同主题默认回填；非法旧值自动跳过；Fight 等计划不受影响。

### 1.6 运行控制面板 + 持久化执行记录
- 新模块 `run-state.js`：`runs.json`（状态目录），`running/succeeded/failed/stopped`、startedAt/finishedAt/exitCode/summary；`MAX_RUNS=8`，`STALE_MS=40 分钟`。
- 新命令 `/maa status`（只读 JSON）；`/maa stop` 重写：本会话 abort → 残留记录 `stopRun` → 兜底 `reapGeneratedTaskProcesses()`（仅杀命令行含 `dsh-generated` 的 `maa.exe/maa-cli.exe`）。
- 执行期间（存活 run）`maa_prepare_plan/strategy/note` 与 `/maa confirm` 全部拒绝新任务（跨会话共享）。
- 客户端：确认后切换为控制面板（本地 ticker 计时、「停止任务」「查看执行记录」），记录来自 `localStorage` + 按需 `/maa status`；**不再轮询**（命令平面会把每次 `/maa*` 回显进对话）。

### 1.7 关键 Bug 修复
- **分队长度 1–32 报错**：客户端 `encodeURIComponent` 的 squad（6 汉字→54 ASCII）未解码就过长度校验。`planner.js` 新增 `decodePanelValue`（仅对含 `%XX` 的串解码）。
- **5 分钟被终止 / `This operation was aborted`**：`/maa confirm` 原来同步等待整次 MAA 执行，被命令传输 5 分钟超时 abort（`RUN-33DD8445`、`RUN-0D6B0333` 都是精确 300 s，日志在任务中途被硬切）。改为 `startMaa` 后台执行：确认立即返回「已开始执行（RUN-…）」，子进程归插件持有，退出时结算 `runs.json`、恢复资源覆盖、释放锁。
- 去掉客户端 3 s/15 s 轮询（曾导致对话里刷 `/maa status` JSON 和 abort 正在执行的 confirm）。

## 2. 文件与接口

| 文件 | 职责 / 关键导出 |
| --- | --- |
| `src/index.js` (1052 行) | 工具与 `/maa` 命令注册；`prepareNotePreview`、`executeDocument(..., {background:true})`、`assertNoActiveRun`、`formatBackgroundResult`、`classifyMaaExecution` |
| `src/runtime/runner.js` (240) | `runMaa`（等待式，带 timeout/abort）、**`startMaa`**（后台，返回 `{pid, done, kill}`） |
| `src/commands/run-state.js` (179, 新) | `beginRun/activeRun/finishRun/stopRun/describeRunState/finishInterruptedRun/reapGeneratedTaskProcesses` |
| `src/commands/panel-memory.js` (133, 新) | `rememberPanelValues/applyRememberedConfig/panelMemoryKey/clearPanelMemory`（仅 Roguelike，key=`Roguelike:<theme>`） |
| `src/strategy/note.js` (223) | `parseStrategyNote`、`noteModelPrompt`、`splitClauses`、`roguelikeTacticClause`、代词/虚词回退 |
| `src/strategy/compiler.js` (678) | `compileStrategyRequest`、`compileRoguelikeFiles`、`writeWildcardTactic`、`listAutopilotStages`、`loadTileIndex`、`placementFor`、`ensureOperatorGroup`、`materializeStrategy`、`installOverlay/recoverStrategyOverlay` |
| `src/commands/planner.js` (371) | `buildTaskDocument`、`applyRoguelikeOverrides`、`coerceOverride`（含 `MAX`）、`decodePanelValue`、`writeGeneratedTask` |
| `src/commands/task-panel.js` (465) | `taskPanelFromDocument`、`applyTaskPanelOverrides`、`MAX_DIFFICULTY` |
| `src/commands/local-command.js` | `/maa` 解析（新增 `status`） |
| `src/client/index.js` (947) | dock 控制面板、`MaaPlanCard`、`useCommandButton(onStart)`、`readRunRecord`、`useRunClock`；无轮询 |
| `src/strategy/memory.js` | 策略记忆（本轮未改；只为 Copilot 生成 `tactic:<kind>`） |

**数据流**：备注 → `parseStrategyNote` → `compileStrategyRequest` → 记忆 → `previewStrategyDetails` → `preparePendingPlan` → 面板 `/maa peek` → `/maa confirm` → `applyTaskPanelOverrides` → `consumePlanFromHumanGesture` → `rememberConfirmedPanel` → `executeDocument({background:true})` → `materializeStrategy`（写 `configDir\resource` overlay + manifest）→ `startMaa run dsh-generated --batch --user-resource` → 退出时 `finishRun` + `restore()`。

## 3. 真实实现状态

| 能力 | 状态 |
| --- | --- |
| 备注解析 / `maa_prepare_note` | 已实现，单测覆盖；真实资源上手工跑过 preview（已删除临时脚本） |
| 招募合成 + 整表覆盖 | 已实现；在真实 BlackFlow 资源上实测过写入与 restore |
| 显式关卡堵门 | 已实现，测试 fixture 覆盖 |
| 无关卡全关卡自动选点 | 已实现；真实资源预览：BlackFlow 1/1、Mizuki 48/48、Sami 45/55、JieGarden 34/38、Phantom 42/47、Sarkaz 27/30 写入成功 |
| 难度 MAX / 面板记忆 | 已实现，单测通过（用内置 fallback 能力）；真实能力下的面板默认值未逐项手测 |
| `/maa status`、`/maa stop`、执行期间拒绝 | 已实现，单测覆盖 |
| **后台执行 `startMaa`** | 已实现，单测（fake `.cmd`）通过；**未经过真实 MAA 长任务验证** |
| 策略记忆管理 UI | 已下线（有意），后端保留 |
| 肉鸽战术写入策略记忆 | **未实现**（避免跨关卡坐标误用） |
| 「最近执行」列表 UI | **未实现**（`/maa status` 返回 `recent`，界面只显示最近一条） |

## 4. 测试

- 全量：`node --test test/*.test.mjs` → **148 tests / 148 pass / 0 fail**
- 新增/更新：`test/run-state.test.mjs`(8)、`test/panel-memory.test.mjs`(6)、`test/confirmation-panel.test.mjs`（+MAX/编码/面板）、`test/strategy-compiler.test.mjs`（+全关卡/别名关卡/合成分组/e2e）、`test/strategy-note.test.mjs`（+8 例）、`test/runner.test.mjs`（+`startMaa` 正常与 abort 两例）
- **未覆盖**：新后台链路在真实 DSH 命令平面 + 真实 MAA 下的端到端；OperBox 计划走后台时的回调解析；`/maa stop` 在真实任务中的进程树终止。

## 5. 已知问题 / 限制

1. 真实 MAA 执行尚未检验：后台改造后 `runs.json` 无新记录。
2. `BlackFlow@Roguelike@Begin` 失败未排查：`asst.log` 有 `[ERR] Failed to convert difficulty text to number. Text = U1T`，随后 `SubTaskError`（`pre_task: RoutingAction`）。疑似进肉鸽前界面识别/难度文本问题。
3. BlackFlow 上游只有 1 个原生 autopilot 关卡（`暗箭难防`），全关卡通配对它等于单关。
4. 萨米 6 个 `_collapse` 变体缺 `Arknights-Tile-Pos` 条目，被显式跳过（有意，不做后缀剥离）。
5. 合成分组优先级固定 `2000/2000`；备注暂不支持给单个干员指定优先级（`maa_prepare_strategy` 的 `priority` 可以）。
6. 命令平面会回显每次 `/maa` 调用 → **不要新增轮询**；需要状态时走显式操作。
7. 无 `manifest.json`（runtime 由 maa-cli 自行管理），不要假设该文件存在。
8. package.json 仍是 `1.0.2`；CHANGELOG 有「未发布」段，未升版本。

## 6. Git 状态

- HEAD：`3ac09e8 1.0.2`（上一提交 `c41234a Fix roguelike confirmation panel`）
- 工作树：14 个已修改文件 + 4 个未跟踪文件；**未提交、未推送、未发布**
- 已修改：`CHANGELOG.md`、`README.md`、`src/client/index.js`、`src/commands/local-command.js`、`src/commands/planner.js`、`src/commands/task-panel.js`、`src/index.js`、`src/runtime/runner.js`、`src/strategy/compiler.js`、`src/strategy/note.js`、`test/{confirmation-panel,runner,strategy-compiler,strategy-note}.test.mjs`
- 新文件：`src/commands/run-state.js`、`src/commands/panel-memory.js`、`test/run-state.test.mjs`、`test/panel-memory.test.mjs`
- diffstat：+1451 / −148（未含 4 个新文件）

## 7. 建议的后续优先级

1. **实机验证**：重启 DSH → `/maa rogue`（JieGarden，难度 MAX）→ 确认后应立刻返回「已开始执行」，跑满 10 分钟不被 abort；中途 `/maa stop` 应终止进程树并记 `stopped`。
2. 若仍中断：对比 `runs.json` 的 `durationMs` 与 `asst.log` 尾部，确认是否还有第二处超时/模拟器断连。
3. 排查 `BlackFlow@Roguelike@Begin` 的 `U1T` 难度文本错误（MaaCore 侧文本识别，可能需要主题难度/界面语言适配）。
4. 真机确认 MAX 与面板记忆在真实能力描述下的默认值。
5. 可选：`/maa status` 的 `recent` 做成「最近执行」列表；肉鸽战术是否入库的记忆策略需重新设计（当前故意不入库）。
6. 收尾时再决定是否升 `1.0.3` 并提交（需用户授权）。
