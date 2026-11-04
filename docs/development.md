# 开发

[← 返回 README](../README.md)

```bash
npm test   # node --test，无第三方依赖
```

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/index.js` | 入口：注册 status 频道，按顺序调用各工具与 `/maa` 命令的注册函数 |
| `src/host/` | 主机侧编排：`/maa` 命令、确认流程、后台执行、停止与所有权、目标与工作流、工具注册（`tools/`） |
| `src/client/` | 面板 UI（必须保持单文件：DSH 只加载 `exports["./client"]` 指向的一个文件） |
| `src/capabilities/` | 从当前 MAA 版本和资源发现能力 |
| `src/commands/` | 命令解析、任务规划、确认码、运行记录 |
| `src/runtime/` | maa-cli 调用、私有运行时、诊断、桌面通知 |
| `src/operators/` | 干员 Box、仓库、培养建议 |
| `src/agent/` | 目标、工作流、养成数据、故障诊断与恢复 |
| `src/strategy/` | 策略编译与记忆、肉鸽资源覆盖、Copilot、基建排班、作业站 |
| `test/` | 全部测试 |
| `scripts/` | 不启动 DSH 也能运行的脚本 |

`test/panel-lifecycle.test.mjs` 是面板端到端测试：用真实入口作为主机、假的 maa-cli 产生真实进程树、极简 React 渲染器渲染真实面板并点击。它不连接模拟器，不能代替实机测试。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `maa_prepare_plan` | 自然语言 → 计划 + 确认按钮 |
| `maa_prepare_strategy` / `maa_prepare_note` | 策略、备注 → MAA 资源或 Copilot 作业 |
| `maa_prepare_infrast` | 自定义基建排班 |
| `maa_copilot` | 搜索作业站 / 准备作业 |
| `maa_runtime_instruction` | 运行中追加停止条件、查询进度 |
| `maa_operator_box` / `maa_depot` | 只读查询 Box / 仓库缓存 |
| `maa_training_advice` | 培养建议 |
| `maa_goal_manager` / `maa_workflow_manager` | 目标与工作流 |
| `maa_stage_schedule` | 今日开放的周常关卡 |
| `maa_query` | maa-cli 版本、目录等只读查询 |
| `maa_doctor` | 环境体检 |
| `maa_runtime` | 查看、安装、更新私有运行时 |

## 发布

```bash
npm test && git commit -am "release: <version>" && npm publish && git tag -a v<version> -m "<version>" && git push origin main --tags
```

发布前先改 `package.json` 的版本号和 CHANGELOG，并确认 `npm whoami` 已登录。用 `&&` 串起来，任何一步失败都会停下。
