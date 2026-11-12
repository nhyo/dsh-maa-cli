# 辅助插件

dsh-maa-cli 本身不带任何运行依赖。体积大的能力，或者超出 MAA 本身范围的能力（比如访问第三方网站、本地识别模型），都放在单独的**辅助插件**里，由用户按需安装。辅助插件不会随 dsh-maa-cli 自动安装。

## 当前的辅助插件

| id | npm 包 | 功能 |
|---|---|---|
| `coverocr` | `dsh-maa-coverocr` | B 站视频作业搜索与封面阵容识别：按“明日方舟 + 关卡”搜索，或读取指定链接；只下载封面、不下载视频流，再拿结果和干员 Box 比较，每条结果附对应链接。 |

## 使用

```
/maa ext                    查看辅助插件状态
/maa ext install coverocr   直接下载并安装（约 300 MB）
```

**安装做了什么**：用当前 DSH 配置自己的包管理器，在配置目录里执行 `add dsh-maa-coverocr --allow-build=!onnxruntime-node`，再把包名加入该配置 `package.json` 的 `dsh.profile.bundles`，DSH 才会加载它。`--allow-build=!onnxruntime-node` 明确拒绝 onnxruntime-node 的安装脚本（它只用来下载 Linux CUDA 运行库），DSH 自带的 pnpm 11 否则会拒绝安装；这个选择会记到配置的 `pnpm-workspace.yaml`。旧写法 `/maa ext install coverocr confirm` 仍可用，效果相同。

DSH 通常会在几秒内自动加载新插件。如果 `/maa ext` 仍显示“已安装，待重启 DSH”，请完全退出 DSH（包括托盘图标）后重新打开。

如果插件无法确认当前 DSH 配置，就不会自动安装，只给出手动命令：

```
dsh plugin --profile <配置名> add dsh-maa-coverocr --allow-build=!onnxruntime-node
```

**开发时**可以用环境变量 `DSH_MAA_COVEROCR_SPEC` 替换安装来源，例如 `link:E:/DESK/dsh-maa-coverocr`。

### B 站视频作业阵容识别

装好 `coverocr` 后，可以说“帮我找 TL-EX-8 的 B 站作业”，也可以把作业视频链接发给模型，例如“看看这几个视频我能不能抄：……”。模型会调用 `maa_video_lineup` 工具，支持关卡关键词和以下几种链接；每次回答都必须逐条附对应视频链接：

- `bilibili.com/video/BV…`

辅助插件会在本机持久复用匿名 B 站会话和 WBI 密钥，所有请求串行限速。遇到 `-412` 等风控时只刷新密钥重试一次；仍失败会进入递增冷却，重启 DSH 也不会反复请求。
- `b23.tv` 短链接
- BV 号

每次最多 5 个链接。

- **只判断是否拥有**：不看练度和技能。
- **缺 1 名也算可抄**：这一名可以借助战。
- **标明阵容的可信度**：封面是编队界面截图时，标为“较完整”；其余情况标为“可能不完整”。
- **只给链接**：视频链接交给你自己打开、手动抄作业；工具不会操作游戏。
- **作业码**：如果简介或 UP 主评论里有 `maa://` 作业码，会一并列出，可以交给现有的作业站流程执行。
- **不支持搜索**：只能处理你给出的链接，不支持按关卡名搜索。B 站的搜索接口会拒绝非浏览器的请求。

## 开发新的辅助插件

1. **提供服务**：新的包在插件入口里调用 `ctx.provide('<服务名>', service)`。`service` 必须带 `apiVersion`（整数）和 `version`（包版本号）。
2. **登记**：在 `src/extensions/registry.js` 的 `EXTENSIONS` 里加一条记录，写明 `id`、`packageName`、`service`、`apiVersion`、`title`、`description`、`size`、`specEnv`。
3. **调用**：在调用处用 `extensionService(ctx, id)` 获取服务。它会检查服务是否存在、`apiVersion` 是否匹配，并返回可读的状态说明；状态不是 ready 时，调用方应提示用户安装，不得自行编造结果。
4. **传入数据**：dsh-maa-cli 把辅助插件需要的数据（干员名单、MAA 资源目录、Box 等）作为参数传进去。辅助插件不读取 dsh-maa-cli 的内部文件，也不依赖它的代码。
5. **接口变更**：接口出现不兼容的修改时，递增 `apiVersion`，并同时更新两边。
