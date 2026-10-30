# 更新日志

### 0.9.3

- **修复插件整体加载失败**：`maa_training_advice` 的返回 schema 用了 DSH 不支持的 `anyOf`，DSH 校验工具参数时抛 `JsonSchemaError`，导致 `apply()` 回滚、6 个工具与 `/maa` 命令全部消失（日志表现为 `1 entry did not activate`）。改用等价的 `oneOf`（`integer` 与 `null` 互斥），其余关键字保持在 DSH 支持的子集内（`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`）。
- **新增只读工具**：`maa_operator_box`（读 Box 缓存）、`maa_training_advice`（按社区杯级 + MAA 职业数据出培养建议，蒂蒂固定置顶）。
- **自动肉鸽参数面板**：计划含 `Roguelike` 步骤时，确认条与工具卡都出现参数区，默认值取 MAA 官方推荐开局并标 `【推荐】`；切换主题会重置该主题的推荐值与专属开关。
- **统一零模型任务面板**：`startup` / `fight` / `infrast` / `recruit` / `mall` / `award` / `rouge` / `reclamation` / `update` 都只准备计划并弹出对应参数面板，点确认才执行；字段定义与服务端校验共用同一来源。
- **主题补齐到 6 个并按上线顺序排列**（傀影 → 水月 → 萨米 → 萨卡兹 → 界园 → 黑流树海），新增 `BlackFlow` 主题与它专属的「刷襁褓动物(30001)」模式。
- **面板全部改为选项**：除刷取次数外一律下拉，开关只有「是 / 否」；刷取次数默认 **9999**、可手输（只收数字，1–99999）。
- **备注栏**：确认按钮旁「30 分钟内有效」右侧新增备注输入，随确认命令以 URL 编码的 `note=` 回到 DSH，由 DSH 自行理解（不保证执行），绝不写入 MaaCore 任务 JSON。
- **高级功能按主题 / 模式收敛**：只渲染并只发送当前配置下 MAA 真正会用的开关（密文板/坍缩范式仅萨米，骰子刷商店仅水月，投资后购物仅模式 1，凹精二直升仅模式 4，月度/深入调查仅 6/7，常乐节点仅 20001，最终 Boss 停止仅非傀影）。
- **面板形状**：右上角改为 `−` / `×` 图标（最小化 / 删除当前卡片），宽度与圆角对齐 DSH 输入框卡片令牌（`--dsh-composer-card-max-width`、`--dsw-radius-panel`）。
- 校验范围同步放宽：肉鸽次数上限 20 → 99999，模式枚举纳入 6/7/10001/20001/30001。
