# dsh-maa-cli

一个 DeepSeek Harness 插件：常用操作通过本地 `/maa` 命令零模型调用执行；复杂自然语言由模型组装成 maa-cli 计划，再由本地确认按钮执行，确认阶段不会再次调用模型。

## 低 Token 用法

以下命令直接在 DSH 的本地命令通道运行，不进入模型上下文：

```text
/maa fight 1-7 2
/maa 刷 1-7 两次
/maa startup
/maa infrast
/maa award
/maa closedown
/maa stop
/maa setup
/maa help
```

`fight` 默认不使用理智药、临期理智药或源石，`infrast` 默认不使用无人机。输入这些明确命令本身就是用户对该次操作的授权。

作战会优先使用游戏内连续作战：请求 1～10 次时，`times` 和 `series` 都设置为该次数（例如 10 次生成 `times: 10, series: 10`）；超过 10 次时使用 `series: 0` 自动分组，避免反复进行单次作战。

任务执行期间，确认条会显示“停止任务”按钮；它等价于本地 `/maa stop`，只终止当前 DSH 会话启动的 maa-cli 进程树，不会关闭游戏、模拟器、MAA 图形界面或其他独立运行的 maa-cli。MaaCore 没有可靠的暂停/继续接口，所以停止后不会自动继续剩余局数；如果游戏已经接受了连续作战，当前战斗或游戏自身排定的连战仍可能继续。

## 安装

发布到 npm 后，普通用户只需要在 DSH 中输入一条命令：

```text
dsh plugin --profile desktop add dsh-maa-cli
```

安装完成后重启 DSH Desktop。插件第一次真正执行游戏任务时，如果电脑上没有配置可用的 maa-cli，会自动下载并配置一套私有运行时；用户不需要再执行第二条安装命令。`/maa setup` 仅用于希望提前下载运行时的用户。

安装命令可以选择以下任意一种来源，每种都只需一条命令：

```text
# npm 正式版（普通用户推荐）
dsh plugin --profile desktop add dsh-maa-cli

# 本地发布包（尚未发布 npm 或离线分发时）
dsh plugin --profile desktop add "D:\下载\dsh-maa-cli-0.9.0.tgz"

# 本地源码目录（仅供开发）
dsh plugin --profile desktop add "link:D:\项目\dsh-maa-cli"
```

注意：第一条按包名安装的命令，只有在维护者把 `dsh-maa-cli` 发布到 npm 后才会在其他电脑上生效。本仓库不打包 maa-cli、MaaCore 或资源，也不包含开发者电脑的绝对路径；运行时会在每位用户自己的 `~/.dsh/maa-cli/runtime` 中按需准备。

复杂任务仍可直接用自然语言告诉 DSH。模型只负责调用一次 `maa_prepare_plan`；计划生成后，DSH 输入框附近会主动显示确认条。点击“确认并执行 MAA”会通过本地 `/maa confirm <code>` 执行，不产生第二条模型消息。思考区内的工具卡也保留同一个按钮作为备用。确认码只对同一 DSH 会话有效、只能使用一次，并在 30 分钟后过期。

**不需要用户预先安装 MAA。** 插件自带一份私有运行时（maa-cli + MaaCore + 资源），第一次使用时自动下载，装在一个目录里，与系统里已有的 MAA 完全隔离。

## 工具

| 工具 | 作用 |
| --- | --- |
| `maa_query` | 只读查询：`version` / `help` / `list` / 各目录位置（`cache_dir`、`hot_update_dir`、`config_dir`、`library_dir`、`resource_dir`、`data_dir`、`log_dir`） |
| `maa_doctor` | 环境体检：maa-cli 版本、AppData 视图、缓存目录可原子写、热更新仓库、连接配置、ADB、ADB 端口、MuMu 管理器，共 9 项 |
| `maa_prepare_plan` | 把自然语言步骤整理成计划并落盘，显示本地确认按钮（30 分钟有效，DSH 重启后仍可确认） |
| `maa_runtime` | `status` / `install` / `update`：查看、安装、更新私有运行时 |

## 私有运行时

- 默认位置：`~/.dsh/maa-cli/runtime`（`DSH_MAA_CLI_RUNTIME_DIR` 可改）。
- 结构：`bin/`（maa-cli）、`data/lib`（MaaCore）、`data/resource`（资源）、`config/profiles/default.toml`、`state/`、`cache/`。
- 安装流程：下载 maa-cli 官方 release（约 3.6 MB）→ 解包 → `maa-cli install --batch`（由 maa-cli 自己下载匹配的 MaaCore 与资源）→ 探测 adb 并写 `default.toml` → 清理几百 MB 的安装缓存。
- 体积：安装完成后约 520–630 MB（MaaCore 约 250 MB，资源约 267 MB）；下载耗时取决于网络。
- 隔离：通过 `MAA_DATA_DIR` / `MAA_STATE_DIR` / `MAA_CACHE_DIR` / `MAA_CONFIG_DIR` 四个变量让 maa-cli 只认这个目录，不会写用户全局的 MAA 目录。
- 生成任务时会先调用 `maa-cli dir config`，再把 `dsh-generated.json` 写入该次运行实际使用的配置目录，避免私有运行时与全局配置目录不一致。
- 卸载：删除该目录即可。
- 不想打开 DSH 时也可直接安装：`node scripts/install-runtime.mjs`（等价于调用 `maa_runtime` 的 `install`，会打印每一步的耗时）。
- adb 探测顺序：`DSH_MAA_CLI_ADB_PATH` → `ANDROID_HOME` / `ANDROID_SDK_ROOT` → `%ProgramFiles%` 与各固定盘的 `Program Files` 下的 MuMu / 雷电 / 蓝叠 → `PATH`。探测不到时会写出不含 `adb_path` 的 `default.toml`，手动补上那一行即可（地址默认 `127.0.0.1:16384`）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_MAA_CLI_RUNTIME_DIR` | 私有运行时根目录 |
| `DSH_MAA_CLI_PATH` / `MAA_CLI_PATH` | 指定别的 maa-cli（优先于私有运行时） |
| `DSH_MAA_CLI_ADB_PATH` | 指定 adb，安装时跳过探测 |
| `DSH_MAA_CLI_STATE_DIR` | 待确认计划的存放目录（默认 `~/.dsh/maa-cli`） |
| `DSH_MAA_CLI_ASSET_URL` | 覆盖 maa-cli 下载地址（内网镜像/离线包） |

## 打包应用（MSIX）注意

从 Microsoft Store 打包的应用启动的进程，`%APPDATA%` / `%LOCALAPPDATA%` 会被重定向到 `%LOCALAPPDATA%\Packages\<包名>\LocalCache\{Roaming,Local}`。插件用 `paths.js` 在两个视图里查找目录，`maa_doctor` 会把看到的实际路径显示出来。

## 许可

插件本身不附带 MaaCore。运行时按需从官方发布渠道下载 MAA / maa-cli，它们遵循各自的许可（MAA 为 AGPL-3.0），下载后请遵守上游协议。

## 开发

```bash
npm test
```

测试使用 Node 内置 `node --test`，不引入任何第三方依赖；`tar` 用于解包（Windows 10+ 自带）。

发布者在确认版本号和许可证后执行：

```bash
npm login
npm publish
```

发布属于 npm 账号操作，不是普通用户安装步骤。
