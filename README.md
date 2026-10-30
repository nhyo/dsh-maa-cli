# dsh-maa-cli

[![npm](https://img.shields.io/npm/v/dsh-maa-cli.svg)](https://www.npmjs.com/package/dsh-maa-cli)
[![license](https://img.shields.io/npm/l/dsh-maa-cli.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把《明日方舟》的日常操作变成一条本地命令，复杂需求才交给模型组装计划。

- **日常操作零模型调用**：`/maa fight 1-7 10` 直接在 DSH 的本地命令通道执行，不进入模型上下文。
- **确认与执行分离**：自然语言需求只消耗一次模型调用生成计划，执行由本地确认按钮触发，确认阶段不再调用模型。
- **不需要预装 MAA**：插件自带私有运行时，首次真正执行任务时自动下载 maa-cli + MaaCore + 资源，与系统里已有的 MAA 完全隔离。
- **运行中可停止**：只终止本会话启动的 maa-cli 进程树，不动游戏、模拟器或其它 MAA 实例。
- **按需自动更新**：开始新任务前至多每 24 小时调用一次 maa-cli 官方更新；培养榜只在用户请求建议时检查。

---

## 目录

- [快速开始](#快速开始)
- [本地命令（零模型调用）](#本地命令零模型调用)
- [自然语言用法](#自然语言用法)
- [工具一览](#工具一览)
- [私有运行时](#私有运行时)
- [环境变量](#环境变量)
- [兼容性](#兼容性)
- [故障排查](#故障排查)
- [安全边界](#安全边界)
- [开发](#开发)
- [常见问题](#常见问题)
- [许可与致谢](#许可与致谢)

---

## 快速开始

```text
dsh plugin --profile desktop add dsh-maa-cli
```
或
```text
dsh plugin --profile web add dsh-maa-cli
```
安装完成后**重启 DSH Desktop**，然后任选一种方式：

```text
/maa fight 1-7 2        # 刷两次 1-7，全程不经过模型
/maa box                # 扫描干员 Box 并保存查询缓存
/maa setup              # 想提前下载运行时的话
```

第一次真正执行游戏任务时会自动准备私有运行时（约 520–630 MB，视网络通常 1–3 分钟）。任务开始前请确保模拟器已经启动；没启动时插件会直接提示「请手动启动mumu模拟器！」，不会消耗理智，计划也不会失效。

## 本地命令（零模型调用）

命令走 DSH 的本地命令通道，**完全不产生模型调用**。

| 命令 | 别名 | 作用 |
| --- | --- | --- |
| `/maa help` | `帮助`、`?` | 显示命令帮助 |
| `/maa fight <stage> [n]` | `刷`、`作战` | 作战，默认 1 次，最多 100 次 |
| `/maa startup` | `启动`、`启动游戏`、`打开游戏`、`打开明日方舟` | 启动游戏并进入主界面 |
| `/maa infrast` | `基建`、`基建换班` | 基建换班，默认不使用无人机 |
| `/maa award` | `领取奖励`、`领奖` | 领取日常与周常奖励 |
| `/maa box` | `operbox`、`扫描干员Box`、`识别干员列表` | 扫描已拥有干员并更新本地缓存 |
| `/maa closedown` | `关闭`、`关闭游戏`、`关闭明日方舟` | 关闭游戏客户端 |
| `/maa stop` | `停止`、`停止任务`、`终止任务` | 停止本会话正在执行的任务 |
| `/maa setup` | `安装运行时`、`初始化` | 下载并配置私有运行时 |
| `/maa confirm MAA-XXXXXX` | — | 确认并执行待办计划（确认按钮等价于此） |

示例：

```text
/maa fight 1-7 10       # 刷十次
/maa 刷 1-7 两次        # 中文数字也认：一 ~ 十
/maa 基建换班
/maa box                # 不调用模型；会操作模拟器扫描干员页
```

约定：

- 作战默认**不使用**理智药、临期理智药或源石；基建默认**不使用**无人机。
- **连续作战**：请求 1–10 次时，`times` 与 `series` 同时设为该次数（10 次即 `times: 10, series: 10`，走游戏内连战）；超过 10 次时 `series: 0`，由 MaaCore 自动分组，避免逐局重复点击。
- 执行期间确认条上会出现「停止任务」按钮，等价于 `/maa stop`。MaaCore 没有可靠的暂停/继续接口，因此停止后不会自动补完剩余局数。

### 干员 Box 查询

`/maa box` 会执行 `StartUp + OperBox`，并把识别出的已拥有干员精简保存到 `~/.dsh/maa-cli/operator-box.json`。缓存只包含干员 ID、名称、星级、精英化、等级、潜能和扫描时间，不包含账号凭据。

扫描一次后，可以直接用自然语言询问：

```text
我有哪些六星干员？
哪些六星还没精二？
维什戴尔多少级、几潜？
给我一份培养建议
```

DSH 会先调用只读的 `maa_operator_box` 查询缓存，不连接模拟器。没有缓存，或用户明确要求刷新时，才会准备一份需要确认的 `StartUp + OperBox` 扫描计划。

每次扫描完成后，插件会主动询问是否需要培养建议。用户主动询问时，DSH 会先显示上次扫描时间，并让用户选择直接使用缓存还是重新扫描；重新扫描仍需单独确认。

培养建议使用以下可审计规则：

- 杯级来自[明日方舟六星干员强度投票箱](https://vote.ltsc.vip)最新已发布主题，按该项目原有的九等分规则归为 `超大上 > 超大中 > 超大下 > 大杯 > 中杯 > 其他`。这是社区投票，不是官方强度结论。
- 职业与子职业读取当前 MAA 运行时自带的 `battle_data.json`，不维护另一份容易过期的名单；职业内排名由同一社区总榜按职业分组得到。
- “已有可用职业覆盖”定义为该职业至少有一名精一或精二干员。没有时会提高该职业候选人在同杯级内的顺序，并明确写出职业缺口原因。
- 只推荐尚未精二、或精二但低于 60 级的已拥有六星；榜单没有收录的干员标为“其他”，不会补造评级或排名。
- 每次生成建议前只检查最新已结束主题 ID；主题未变化时直接复用 `~/.dsh/maa-cli/training-ranking.json`，不重复下载完整榜单。新主题下载成功后才原子替换；检查失败则继续使用旧缓存。
- 这是蒂蒂，她很可爱！！！

## 自然语言用法

复杂需求仍然可以直接说，例如「先启动游戏，清一下基建，再刷十次 1-7，最后领奖励」。

1. 模型调用一次 `maa_prepare_plan`，把需求整理成有顺序的步骤，写入任务文件并**落盘保存**。
2. DSH 输入框附近出现确认条（思考区的工具卡里也有同样的按钮）。
3. 点击「确认并执行 MAA」→ 本地执行 `/maa confirm <code>` → 运行 maa-cli。**这一步不会调用模型。**

确认码规则：

- 只对**同一个 DSH 会话**有效；
- **一次性**，用过即失效；
- **30 分钟**后过期；
- DSH 重启后计划仍在磁盘上，可继续确认（默认 `~/.dsh/maa-cli/pending-plans.json`，可用 `DSH_MAA_CLI_STATE_DIR` 改目录）。

## 工具一览

模型侧可用的工具（本地命令不需要它们）：

| 工具 | 作用 |
| --- | --- |
| `maa_query` | 只读查询：`version`、`help`、`list`，以及各目录位置（`cache_dir`、`hot_update_dir`、`config_dir`、`library_dir`、`resource_dir`、`data_dir`、`log_dir`） |
| `maa_operator_box` | 只读查询上次 `OperBox` 缓存，可按星级、名称和精英化筛选；不会连接模拟器 |
| `maa_training_advice` | 基于 Box 缓存、MAA 职业数据和公开社区榜生成有序培养建议；首次请求会先询问使用缓存还是重扫 |
| `maa_doctor` | 环境体检，只读：maa-cli 版本、AppData 视图、缓存目录可原子写、热更新仓库、连接配置、ADB 文件、ADB 端口、MuMu 管理器，共 9 项 |
| `maa_prepare_plan` | 把自然语言步骤整理成计划并落盘，显示本地确认按钮 |
| `maa_runtime` | `status` / `install` / `update`：查看、安装、更新私有运行时；`force` 强制重装，`keepCaches` 保留安装包 |

## 私有运行时

插件不打包 maa-cli、MaaCore 或资源，而是给每位用户在自己的目录里准备一份：

- **默认位置**：`~/.dsh/maa-cli/runtime`（`DSH_MAA_CLI_RUNTIME_DIR` 可改）。

- **结构**：

  ```text
  runtime/
  ├─ bin/                    maa-cli（Windows 下是 maa.exe）
  ├─ data/lib/               MaaCore 与依赖 DLL
  ├─ data/resource/          资源
  ├─ config/profiles/default.toml
  ├─ state/                  日志等
  ├─ cache/                  运行期缓存（安装包会被自动清理）
  └─ runtime.json            版本与安装信息
  ```

- **安装流程**：下载 maa-cli 官方 release（约 3.6 MB）→ `tar` 解包 → `maa-cli install --batch`（由 maa-cli 自己下载匹配的 MaaCore 与资源）→ 探测 adb 并生成 `default.toml` → 清理几百 MB 的安装缓存。

- **自动更新**：准备启动新任务时检查上次更新时间；距离上次检查满 24 小时才运行一次官方 `maa-cli update --batch`。maa-cli 自己判断远端版本，版本未变不会重复安装。更新过程全局互斥；已有任务运行时跳过，更新结束后任务才会启动。更新前用同盘硬链接保存旧 `lib`/`resource` 快照，成功后清理，失败或中断则原子恢复旧版本。

- **体积**：装完约 520–630 MB（MaaCore 约 250 MB，资源约 267 MB）。

- **隔离**：通过 `MAA_DATA_DIR` / `MAA_STATE_DIR` / `MAA_CACHE_DIR` / `MAA_CONFIG_DIR` 四个变量让 maa-cli 只认这个目录，不会读写用户全局的 MAA 配置与缓存。

- **生成任务时的目录**：先执行 `maa-cli dir config`，把任务文件写到该进程**实际使用**的配置目录，避免私有运行时与全局配置不一致。

- **卸载**：直接删除该目录即可，不影响系统里的 MAA。

- **不开 DSH 也能装**：`node scripts/install-runtime.mjs`（会打印每一步的耗时）。

- **adb 探测顺序**：`DSH_MAA_CLI_ADB_PATH` → `ANDROID_HOME` / `ANDROID_SDK_ROOT` → `%ProgramFiles%` 与各固定盘的 `Program Files` / `Program Files (x86)` 下的 MuMu / 雷电 / 蓝叠 → `PATH`。探测不到时会写出不含 `adb_path` 的 `default.toml`，手动补一行即可（地址默认 `127.0.0.1:16384`）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_MAA_CLI_RUNTIME_DIR` | 私有运行时根目录 |
| `DSH_MAA_CLI_PATH` / `MAA_CLI_PATH` | 指定别的 maa-cli（优先于私有运行时；指向不存在的文件会直接报错，不会偷偷下载） |
| `DSH_MAA_CLI_ADB_PATH` | 指定 adb，安装时跳过探测 |
| `DSH_MAA_CLI_STATE_DIR` | 待确认计划的存放目录（默认 `~/.dsh/maa-cli`） |
| `DSH_MAA_CLI_ASSET_URL` | 覆盖 maa-cli 下载地址（内网镜像或离线 zip） |

## 兼容性

- **系统**：Windows 10/11 x64（运行时来自 maa-cli 官方发布，Linux/macOS 理论上同样适用，但未实测）。
- **Node**：`>=22`（只用 `node --test`、`node:fs` 等内置模块，无第三方依赖）。
- **DSH**：`dshReleases: 0.2.1-rc.3` 标记为兼容。
- **模拟器**：任何能被 adb 连接的 Android 模拟器；MuMu 12 是主要测试环境（`127.0.0.1:16384`、`MuMuEmulator12`、MiniTouch）。
- **服务区**：`Official`、`Bilibili`、`Txwy`、`YoStarEN`、`YoStarJP`、`YoStarKR`。

## 故障排查

先跑一次体检（模型侧 `maa_doctor`）：9 项里任何一项红了，基本都能直接定位问题。

| 现象 | 原因与处理 |
| --- | --- |
| `I/O error: 系统无法将文件移到不同的磁盘驱动器。 (os error 17)` | 目标目录被 **EFS 加密**，maa-cli 的「同目录临时文件 + rename」原子写在加密目录上必然失败。把该目录 `cipher /d` 解密，或用 junction 重定向到未加密盘（`mklink /J`）。 |
| `Resource directory ... not found, ignoring` | maa-cli 回退到了内置资源，通常不影响功能；若行为异常，用 `maa_doctor` 看资源目录，再 `maa_runtime update`。 |
| 提示「请手动启动mumu模拟器！」 | 模拟器没启动或没开 ADB 调试。启动后**重新点一次确认**即可，计划不会失效。 |
| adb 连不上 / 端口不通 | `adb devices` 看设备；MuMu 需要在设置里开启 ADB，端口默认 `16384`；必要时 `adb connect 127.0.0.1:16384`。 |
| 目录一会儿存在一会儿不存在 | 从 Microsoft Store 打包的应用启动进程时，`%APPDATA%` / `%LOCALAPPDATA%` 会被重定向到 `%LOCALAPPDATA%\Packages\<包名>\LocalCache\{Roaming,Local}`，且「写后才物化」。插件用 `paths.js` 在两个视图里查找，`maa_doctor` 会显示实际路径。 |
| 运行时下载慢或失败 | 设置 `DSH_MAA_CLI_ASSET_URL` 指向镜像/离线 zip，或手动下载后放到 `runtime/downloads/` 再重试 `install`。 |
| 提示「当前 DSH 会话已有一个 MAA 任务正在执行」 | 同一会话同时只能跑一个任务；先 `/maa stop` 或等它结束。 |
| 确认按钮点了没反应 / 提示确认码不匹配 | 确认码单会话、一次性、30 分钟过期；重新让模型准备一次计划即可。 |

## 安全边界

- 只调用 maa-cli 的**白名单**子命令（查询类 `version` / `help` / `list` / `dir`，执行类 `run`），并对参数做字符校验；不会执行任意 shell。
- 只操作游戏：不涉及充值、不修改账号资料、不改动系统 MAA 的配置。
- 停止操作只对**本会话启动的进程树**执行 `taskkill /T`，不会波及其它 MAA 实例、游戏或模拟器。
- 确认码机制保证「模型提议」与「用户批准」是两次独立动作。

## 开发

```bash
npm test          # node --test，无第三方依赖
```

主要文件：

| 文件 | 职责 |
| --- | --- |
| `index.js` | 注册工具与 `/maa` 本地命令，串起确认与执行 |
| `client.js` | 客户端 UI：计划卡片、确认条、停止按钮 |
| `local-command.js` | 本地命令解析（中英文别名、中文数字） |
| `planner.js` | 自然语言步骤 → MaaCore 任务 JSON（含连战分组） |
| `confirmation.js` | 确认码生成/校验、30 分钟 TTL、跨重启读取 |
| `state.js` | 计划的磁盘存储（临时文件 + rename，失败回退直接写） |
| `runner.js` | 调用 maa-cli（超时、输出上限、进程树终止）、CLI 路径解析 |
| `paths.js` | `%VAR%` 展开、MSIX AppData 双视图解析、目录创建 |
| `preflight.js` | 执行前确保运行时目录存在 |
| `doctor.js` | 九项环境体检 |
| `emulator.js` | 模拟器端口预检与提示文案 |
| `runtime.js` | 私有运行时：下载、解包、安装、更新、清理缓存 |

发布流程：

```bash
# 1. 改 package.json 的 version
npm test
npm publish                       # 2. 发布到 npm
git tag -a v<version> -m "<说明>"  # 3. 打 tag
git push origin main --tags       # 4. 推送并创建 GitHub Release
```

## 常见问题

**需要先装 MAA 吗？**
不需要。插件会自己准备运行时；系统里已有的 MAA 也不会被影响。

**会覆盖我现有的 MAA 配置吗？**
不会。所有读写都限制在私有运行时目录内，通过四个 `MAA_*_DIR` 环境变量隔离。

**装了插件以后原来的 MAA 还能用吗？**
能。两者互不干扰。

**为什么不把 MAA 打包进 npm 包？**
MaaCore 与资源有几百 MB，且 MAA 采用 AGPL-3.0，重新分发需要承担相应的源码义务。按需下载更轻，也更容易跟随上游更新。

**支持哪些服？**
Official、Bilibili、Txwy（台服）、YoStarEN/JP/KR。用自然语言指定即可，例如「日服刷 1-7 两次」。

**能一次刷 100 次以上吗？**
单条命令上限 100；需要更多可以分多次执行。

**任务跑到一半能暂停吗？**
MaaCore 没有可靠的暂停/继续接口，只能停止（`/maa stop`），停止后不会自动补完剩余局数。

**日志在哪里？**
私有运行时下的 `state/debug/`；也可以用 `maa_query` 的 `log_dir` 查询实际路径。

## 许可与致谢

- 插件本身：[MIT](LICENSE)。
- 插件不附带 MaaCore。运行时会从官方渠道下载 [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights) 与 [maa-cli](https://github.com/MaaAssistantArknights/maa-cli)，它们遵循各自的许可（MAA 为 AGPL-3.0），下载后请遵守上游协议。
- 感谢 MaaAssistantArknights 团队维护 MAA 与 maa-cli，以及 DeepSeek Harness 提供插件机制。
