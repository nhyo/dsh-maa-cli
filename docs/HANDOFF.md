# 交接说明（给下一位接手的人 / 模型）

本文件描述最近一轮开发做了什么、改了哪些文件、验证到什么程度、还剩什么没做。目标读者是完全没有本轮上下文的接手者。

## 1. 项目与环境事实

- 仓库：`E:\DESK\dsh-maa-cli`（remote `https://github.com/nhyo/dsh-maa-cli.git`，分支 `main`）
- 运行环境：Windows 11 x64 + DSH Desktop 0.2.1-rc.3（Electron，nightly）；插件以 `link:E:/DESK/dsh-maa-cli` 的形式装进 `C:\Users\nhyo\.dsh\profiles\desktop`，改完代码**必须重启 DSH Desktop** 才生效。
- 判断「改动是否真的加载了」：`Get-Process *DeepSeek* | Select Id,StartTime` 的启动时间必须晚于 `src/client/index.js` / `src/index.js` 的 `LastWriteTime`。另外模型侧 `maa_prepare_plan` 的工具说明里也能看出服务端版本（旧版本写 `startsCount (1-20)`，新版本写 `(1-99999; the confirmation panel starts at 9999)`）。
- 版本：`package.json` 已是 **0.9.2**（未发布）；npm 上的 0.9.1 是旧代码，不含本轮任何改动。
- 测试：`node --test`，当前 **93/93 通过**，无第三方依赖，无需安装。

## 2. 本轮改动（按文件）

### `planner.js` —— 肉鸽步骤的参数模型

- `ROGUELIKE_THEMES` 增加 `'BlackFlow'`（现为 6 个：Phantom / Mizuki / Sami / Sarkaz / JieGarden / BlackFlow）。
- `ROGUELIKE_MODE_VALUES = [0, 1, 4, 5, 6, 7, 10001, 20001, 30001]`，并在 `buildStep` 里用白名单校验 `mode`（此前是 `optionalInteger(..., 0, 5)`，会把 6/7/10001/20001/30001 直接判为越界）。
- `startsCount` 上限从 20 放宽到 **99999**（`ROGUELIKE_OVERRIDES` 与 `buildStep` 两处），对应 MaaCore `starts_count`。
- `ROGUELIKE_OVERRIDES` 新增三个开关：`useFoldartal`（`use_foldartal`）、`checkCollapsalParadigms`（`check_collapsal_paradigms`）、`refreshTraderWithDice`（`refresh_trader_with_dice`），`ROGUELIKE_OVERRIDE_LABELS` 同步补中文名。现在共 23 个可调键。
- 新增 `roguelikePanelFromDocument(document)`：把 `Roguelike` 任务的 snake_case `params` 映射回面板的 camelCase 键（`PANEL_KEY_BY_PARAM`），供 `/maa peek` 回读；计划里没有肉鸽任务时返回 `null`。
- `applyRoguelikeOverrides(document, overrides)` 仍然只在参数合法时才改动任务 JSON，并且**不会**把插件专用键写进 MaaCore 任务文件（有测试断言）。
- 新增 `ROGUELIKE_THEME_LABELS`（英文值 → 中文全名）让计划摘要显示「肉鸽 萨卡兹的无终奇语 ×3」而不是 `Sarkaz`；新增 `ROGUELIKE_THEME_ALIASES` + `resolveRoguelikeTheme(input)`（中英文/全名 → 规范英文值，非法值抛「无法识别肉鸽主题」）。

### `local-command.js` —— 确认命令的表单

- 截图中的 9 个主任务均改为项目名入口：`startup` / `fight`（兼容 `flight`）/ `infrast` / `recruit` / `mall` / `award` / `rouge` / `reclamation` / `update`。它们全部返回 `kind:'plan'`，只准备计划并打开面板，不直接执行。
- `/maa fight 1-7 2`、`/maa rouge 萨米 3` 等旧写法继续兼容，但只用于预填面板。
- confirm 正则改为 `^confirm\s+(MAA-[A-F0-9]{6})(?:\s+(.+))?$`，把 `key=value` 列表放进 `overrides`。
- **零模型肉鸽命令**：`/^(?:rouge|rogue|roguelike|肉鸽|自动肉鸽)(?:\s+(\S+))?(?:\s+(\d+))?(?:\s+(.+))?$/`，返回 `{ kind:'plan', steps:[{type:'Roguelike', theme, startsCount}], roguelikeOverrides }`——**只准备、不执行**，客户端收到命令结果后弹面板。主题可省略（默认 `Phantom`）并走 `resolveRoguelikeTheme`，位置参数是局数（默认 1，1–99999），其余 token 交给 `parseOverrides`。
- `peek`：`/^(?:peek|查看计划)\s*(MAA-[A-F0-9]{6})?$/`，返回 `{ kind:'peek', confirmationCode }`，只读回读待确认计划（面板用它填参数），不消费。
- `parseOverrides(raw)` 解析 `key=value`；token 不合法时抛「无法识别的确认参数」。
- HELP 文本补了 `rogue` 与 `note=` 的说明。

### `confirmation.js` —— 消费确认码前的只读查看

- 新增 `peekPendingPlan(agent, options)`：只读返回 pending，不删除、不改变 TTL，用于**先校验参数再消费确认码**。

### `src/commands/task-panel.js` —— 统一 MAA 参数面板

- `taskPanelFromDocument(document)` 将待确认文档映射成 `{ type, title, fields, values }`；字段类型、中文标签、选项、范围、默认值集中在服务端维护。
- `applyTaskPanelOverrides(document, overrides)` 按任务类型做布尔、整数、枚举、多选和列表校验；非法值不会消耗确认码。
- 覆盖 StartUp / Fight / Infrast / Recruit / Mall / Award / Roguelike / ReclamationAlgorithm / UserDataUpdate / CloseDown。
- `UserDataUpdate` 不虚构 MaaCore 类型，而是按面板开关生成 `OperBox` / `Depot` 任务。

### `src/index.js` —— 服务端串接

- confirm 分支的新顺序：`ensureMaaCli` → `checkEmulator` → `peekPendingPlan`（仅当带参数）→ `applyTaskPanelOverrides` → `consumePlanFromHumanGesture` → `executeDocument(patched.document ?? pending.document, ...)`。**参数非法时计划不会被消耗**，用户可以改完再点。
- 新增 `export function decodeConfirmationNote(raw)`：`decodeURIComponent`（非法编码报错）→ 把 `\r\n\t` 折成空格 → trim → 空值返回 `''` → 超过 120 字符报错。备注不进 MaaCore，只拼进结果文本和执行摘要（`｜备注（DSH 自行理解，不保证执行）：…`）。
- `maa_prepare_plan` 的工具说明改了两处：`startsCount` 写成 `(1-99999; the confirmation panel starts at 9999)`；补一句面板里有备注栏、备注由 DSH 自行理解但不保证执行。
- `/maa` 命令的 `input.hint` 只列项目入口：`startup | fight | infrast | recruit | mall | award | rouge | reclamation | update | closedown | help`，避免暗示用户必须先手写参数。
- 命令 handler 里，所有项目命令的 `plan` 分支只做 `buildTaskDocument` + 可选参数覆盖 + `preparePendingPlan`，然后返回「MAA 计划待确认：… 确认码 MAA-XXXXXX」——**不执行**。
- `peek` 分支返回 `JSON.stringify({ code, summary, panel: taskPanelFromDocument(document) })`；只读、不消费，面板用它填字段与初值。

### `src/client/index.js` —— 客户端确认面板（单文件改动最大，+421 行）

结构：UMD 包装 `window.__ModuleLoader__.load({...})`，用插件注入的 `React` / `h` 渲染，向 `tool.call.toolview`（key `maa_prepare_plan`）与 `conversation.input.dock`（id `maa-confirm`）两个槽位注册组件。

- 主题：`ROGUELIKE_THEMES` 6 项，顺序为傀影 → 水月 → 萨米 → 萨卡兹 → 界园（显示名「岁的界园志异」）→ 黑流树海。
- 推荐默认值：`ROGUELIKE_PRESETS`（按主题给 difficulty / squad / squads / roles / coreChar / chars，维什戴尔带 `useSupport: true`），新增 `BlackFlow = { 特勤分队, 堡垒战术分队, 稳扎稳打/坚不可摧, 机械师 }`。
- 选项名单（手工固化，MAA 资源里取不到）：`ROGUELIKE_SQUAD_NAMES`（44 个分队）、`ROGUELIKE_ROLE_GROUPS`（取长补短 / 稳扎稳打 / 坚不可摧）、`ROGUELIKE_CHARS`、`DIFFICULTY_OPTIONS`(0–15)、`INVESTMENT_OPTIONS`、`ROGUELIKE_MODES`（含 `themes` 过滤：5 仅萨米、10001 仅萨卡兹、20001 仅界园、30001 仅黑流树海）与 `modesForTheme()`。
- 面板交互：除刷取次数外**全部是下拉**；布尔用 `boolOptions`（是 / 否）；`digitField` 是唯一文本输入（刷取次数，`inputMode=numeric`，用正则剥掉非数字，最多 5 位，失焦时若为空或 <1 回填 9999），默认值硬编码 **9999**（不跟随计划里的次数）。
- 备注栏：`ConfirmButton` 在「30 分钟内有效」右侧渲染 `.maa-note-input`（`maxLength=120`，placeholder「备注：想让 DSH 额外做的事（不保证执行）」），非 ready 状态禁用。备注写进 store 的 params，由 `confirmLine` 以 `note=` + `encodeURIComponent` 追加。
- 主题 / 模式切换会重置专属项：`changeTheme` 清掉密文板 / 坍缩范式 / 骰子刷商店 / 最终 Boss 停止并重置该主题推荐值；`changeMode` 清掉模式专属开关（投资后购物、凹精二直升、月度 / 深入调查自动切换、常乐节点）。
- 高级功能：`ADVANCED_KEYS`(15) + `ADVANCED_LABELS` + `allowedAdvancedKeys(value)` 决定「渲染哪些」与「发送哪些」。规则：
  - `useNonFriendSupport` 仅当 使用助战=是
  - `stopAtFinalBoss` 仅 主题 ≠ 傀影
  - `stopAtMaxLevel` / `investmentEnabled` 总是
  - `investmentsCount` / `stopWhenInvestmentFull` 仅 投资源石锭=是
  - `investmentWithMoreScore` 仅模式 1；`startWithEliteTwo` 仅模式 4；`onlyStartWithEliteTwo` 仅模式 4 且 凹精二直升=是
  - `monthlySquadAutoIterate` 仅模式 6；`deepExplorationAutoIterate` 仅模式 7；`findPlayTimeTarget` 仅模式 20001
  - `useFoldartal` / `checkCollapsalParadigms` 仅萨米；`refreshTraderWithDice` 仅水月
- `confirmLine(code, params)`：逐键拼 `key=value`，并在 `params.theme` 存在时过滤掉 `allowedAdvancedKeys` 之外的键，保证不会发出 MAA 会忽略的开关。
- 卡片外观：`MaaConfirmDock` 支持折叠（`−` / `+`）与删除（`×`），`dismissedPlans` 让被删的卡片在工具卡上也同步隐藏；宽度 / 圆角直接复用 DSH 前端令牌（`--dsh-composer-card-max-width`、`--dsw-radius-panel`、`--dsh-composer-dock-inset`），不是写死像素。
- 新增通用 `TaskSettingsPanel`：按服务端字段描述渲染复选框、下拉框、数字框、文本框和多选组；肉鸽继续使用专用 `RoguelikePanel`。
- `confirmLine(code, params, fields)` 只发送当前任务白名单中的可见字段，字符串使用 URL 编码，数组使用逗号传输。

### `test/confirmation-panel.test.mjs` / `README.md` / `package.json`

- 测试现为 93 项；新增项目名入口、9 类面板映射、各 MaaCore 参数类型转换、更新数据组合、跨字段拒绝用例，以及注册后的 `/maa fight` → `/maa peek` 面板链路测试。
- README 更新：主题表补黑流树海并改名「岁的界园志异」、基础字段表、高级功能表（四列，含出现条件）、备注语义、校验范围 1–99999、只有刷取次数可手输、新增「更新日志」章节。
- `package.json` 的 `scripts.test` 统一运行 `test/`；version 0.9.2（未发布）。

## 3. 满足的功能（对应需求）

1. 截图中的 9 个 MAA 主任务都可只输入 `/maa + 项目名` 打开参数面板，且**只能改参数、不能绕过确认**：改参数不改确认码，执行仍走本地命令通道、零模型调用。
2. 面板默认值 = MAA 官方推荐开局（分队 / 职业组 / 开局干员），带【推荐】标记，可手动改。
3. 「高级功能」对齐 MAA 肉鸽设置，且**按主题 / 模式动态收敛**——每个出现的选项在当前配置下都真正生效，不会出现「改了没用」的项。
4. 主题补齐到最新（黑流树海）并按上线顺序排列。
5. 所有输入都能选（布尔是「是 / 否」），只有刷取次数允许手输数字，默认 9999。
6. 备注栏：用户在「30 分钟内有效」右侧写一句话，随确认命令回到 DSH，由 DSH 自行理解执行、不保证执行；服务端强制 120 字上限与 URL 编码校验。
7. 参数错误时计划不被消耗（先 `peekPendingPlan` 校验，再 `consumePlanFromHumanGesture`）。
8. 面板可最小化 / 删除，不再挡屏幕；宽度与圆角与输入框一致。
8.1 客户端监听 `command/executed`：见到含「MAA 计划待确认」的命令结果就 `/maa peek <code>` 回读计划，把参数塞进 dock store 并弹出面板——这条路径不经过模型。
9. **所有主任务都可零模型调用**：项目命令只准备计划并弹出面板，点「确认并执行 MAA」才运行；面板、改参数、确认都在本地命令通道。

## 4. 验证方式（可复现）

```powershell
cd E:\DESK\dsh-maa-cli
node --test test/*.test.mjs                        # 93/93 通过
node -e "const fs=require('fs'); new Function('window', fs.readFileSync('src/client/index.js','utf8')); console.log('syntax ok')"
node -e "import('./src/index.js').then(m=>{const c={commands:[],tools:[]};m.apply({commands:{register:d=>c.commands.push(d.name)},tools:{register:d=>c.tools.push(d.name)}});console.log(c)})"
```

面板外观可用 stub React 渲染脚本离线核对（`$env:TEMP` 下的临时脚本，未入库）：抓 `conversation.input.dock` 的组件，递归调用函数组件展开，断言「几个 select、有没有 input、各下拉项文本」。上一轮的输出：Phantom/mode0 下 12 个字段全下拉；Sami/mode5 多出「打到最终 Boss 停 / 使用密文板 / 检测坍缩范式」；Mizuki/mode1 多出「投资后购物 / 骰子刷新商店」；并生成 `... note=%E6%89%93...` 的确认行。

## 5. 已知约束与坑（不要重复踩）

- **DSH 工具 schema 子集**：只支持 `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`。用 `anyOf` / `allOf` / `pattern` / `format` / `minimum` / `if` / `not` 会让 `ctx.tools.register` 抛 `JsonSchemaError`，**整个 `apply()` 回滚**，表现是插件「装了但没加载」。本轮就是修这个（`src/index.js` 第 111 行附近，`anyOf` → `oneOf`）。
- **改完必须重启 DSH Desktop**（`src/client/index.js` 走客户端 bundle，`src/index.js` 走服务端注册）。只刷新页面不足以更新服务端。
- `maa_prepare_plan` 的 `StartUp` 步骤**不接受** `squad`（会报 `Error: StartUp.squad is not supported`），分队只能写在 `Roguelike` 步骤里。
- 分队 / 职业组 / 干员名单在 MAA 资源里是图片识别，没有文本表；本地 `MAA.dll` 里也取不到主题显示名。现有名单是手工固化 + 官方文档「推荐开局」表，更新要人工同步。
- 面板默认值顺序：计划值 → 主题推荐 → 内置默认；**刷取次数例外，永远从 9999 起**。
- 备注只走 `note=`，解码后不进任务 JSON；`decodeConfirmationNote` 对非法 URL 编码、超 120 字会抛错。
- `src/client/index.js` 的 `panelDefaults(step)` 是面板初值的唯一来源（推荐开局 + 计划覆盖）；`commandRunner(ctx, sessionId)` 是本地命令的唯一出口，工具卡与命令通知都复用它。
- `src/client/index.js` 是字符串拼接式的 `h(...)`，没有 JSX/编译步骤；改完用 `new Function('window', src)` 做语法检查最快。
- 所有零模型项目命令都**不直接执行**：只 `preparePendingPlan`，再由客户端 `command/executed` 监听器 `/maa peek` 回读并弹面板；点确认才 `/maa confirm`。别把任一项目改回直跑。
- `planner.js` 的 `ROGUELIKE_THEME_LABELS`（英文→中文）只用于摘要显示；`ROGUELIKE_THEMES`（Set）才是 MaaCore 接受的规范值。

## 6. 未完成 / 建议下一步

1. **提交与发布**：`git add -A && git commit`，然后 `npm version`（已是 0.9.2）→ `npm test` → `npm pack --dry-run` → `npm publish` → `git tag v0.9.2 && git push origin main --tags`。本轮**没有**提交、没有发版。
2. **客户端自动化测试**：目前 `src/client/index.js` 只有临时冒烟脚本，没有入库的 DOM 断言。若要长期维护，可把「按主题渲染哪些字段」的期望表固化成一个 fixture 测试。
3. **可选的肉鸽增强**：三顺位开局（`core_char_list`，每顺位独立助战、三顺位职业不能相同）、黑流树海专属 `blackflow_strategy` / `blackflow_cultivation_target` / `blackflow_ending`、萨米密文板列表（`start_foldartal_list`）、模式 4 的 `collectible_mode_start_list`。这些 MaaCore 都支持，但面板目前没暴露。
4. `E:\DESK\dsh-maa-cli\src\index.js.orig` 备份文件已确认不存在，无需处理。

## 7. 当前运行时状态

- Desktop 已于 2026/10/30 2:12 左右重启，加载的是本轮最新代码；已在真实界面输入 `/maa fight`，成功弹出「理智作战参数」面板。
- 桌面验证留下一个未消费的理智作战计划；没有点击「确认并执行 MAA」，游戏未被操作，计划 30 分钟后自动过期。
- 待确认计划落盘在 `C:\Users\nhyo\.dsh\maa-cli\pending-plans.json`；插件私有运行时与状态都隔离在 `C:\Users\nhyo\.dsh\maa-cli` 下。
