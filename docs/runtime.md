# 私有运行时与配置

[← 返回 README](../README.md)

## 私有运行时

插件不打包 MAA，而是在第一次执行任务时下载到 `~/.dsh/maa-cli/runtime`（约 520–630 MB），与系统里已有的 MAA 完全隔离。删除该目录即可卸载。

```text
runtime/
├─ bin/            maa-cli
├─ data/lib/       MaaCore
├─ data/resource/  资源
├─ config/         连接配置 default.toml
├─ state/          日志（state/debug/）
└─ runtime.json    版本与安装信息
```

- **安装**：下载 maa-cli 官方发行版 → `maa-cli install` 下载 MaaCore 和资源 → 探测 adb 并生成配置。不开 DSH 也可以运行 `node scripts/install-runtime.mjs`。
- **自动更新**：开始任务前，距上次检查满 24 小时就运行一次 `maa-cli update`，期间面板显示「正在更新」。更新失败会回滚到旧版本。
- **adb 探测**：`DSH_MAA_CLI_ADB_PATH` → Android SDK → 常见模拟器安装目录 → `PATH`。找不到时在 `default.toml` 里手动补 `adb_path`（地址默认 `127.0.0.1:16384`）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_MAA_CLI_RUNTIME_DIR` | 私有运行时目录 |
| `DSH_MAA_CLI_PATH` / `MAA_CLI_PATH` | 使用别的 maa-cli（不存在时直接报错） |
| `DSH_MAA_CLI_ADB_PATH` | 指定 adb |
| `DSH_MAA_CLI_STATE_DIR` | 计划、记忆、缓存的存放目录（默认 `~/.dsh/maa-cli`） |
| `DSH_MAA_CLI_ASSET_URL` | maa-cli 下载地址（镜像或离线 zip） |
| `DSH_MAA_NOTIFY` | 设为 `0` 关闭桌面通知 |

## 兼容性

- **系统**：Windows 10/11 x64（Linux / macOS 理论可用，未实测）
- **Node**：22 及以上，无第三方依赖
- **DSH**：0.2.1-rc.3
- **模拟器**：能被 adb 连接即可，主要在 MuMu 12 上测试
- **服务器**：官服、B 服、台服、国际服（英 / 日 / 韩）

## 安全边界

- 只调用 maa-cli 的白名单子命令，不执行任意 shell。
- 只操作游戏，不涉及充值、账号资料和系统 MAA 配置。
- 停止只终止本插件记录的进程树，并要求进程命令行带 `dsh-generated` 标记，不会误杀其他 MAA。
- 「模型提议」和「用户确认」始终是两个独立动作。
- 遇到未知状态、预算不足或可能重复消耗时，停下来等你确认。
