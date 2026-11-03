# Local commands and panels

[← Back to README](../../README.en.md)

`/maa` commands go through DSH's local command channel and **never call the model**. Task commands only open a parameter panel; the game is touched only after you click "Confirm and run MAA".

## Commands

| Command | Aliases | Purpose |
| --- | --- | --- |
| `/maa startup` | `启动游戏` | Start up the game |
| `/maa fight` | `刷`, `作战` | Combat (sanity) |
| `/maa infrast` | `基建` | Base shift rotation |
| `/maa recruit` | `公招` | Auto recruitment |
| `/maa mall` | `信用收支` | Credit store |
| `/maa award` | `领奖` | Collect rewards |
| `/maa rouge` | `rogue`, `肉鸽` | Auto Integrated Strategies |
| `/maa reclamation` | `生息演算` | Reclamation Algorithm |
| `/maa update` | `更新数据` | Update operator Box / depot data |
| `/maa box` | `扫描干员Box` | Update the operator Box only |
| `/maa closedown` | `关闭游戏` | Close the game |
| `/maa stop [RUN-… / MAA-…]` | `停止` | Stop this session's task; returns only after the process tree has exited |
| `/maa setup` | `安装运行时` | Download the private runtime in advance |
| `/maa help` | `帮助` | Command help |

`/maa status`, `/maa peek` and `/maa confirm` are used by the panels internally; you rarely type them. Older forms such as `/maa fight 1-7 10` still work, but only to pre-fill the panel.

## Parameter panels

- Parameters and options come from the MAA version and resources actually in use, and are validated again before confirming; a failed validation does not use up the confirmation code.
- Basic options are shown directly, the rest under "Advanced settings"; MAA's own hints appear under the matching field.
- Optional fields left unselected are not sent to MaaCore; a missing required field is named explicitly.

### Panel memory

Each `/maa` panel remembers the settings of your last **successful** confirmation (Integrated Strategies per theme). Pre-fill order: parameters typed in the command → last confirmed settings → MAA defaults. After an MAA update, only fields that became invalid fall back to defaults.

Memory only applies to the model-free panels; a plan prepared from natural language runs exactly as planned. Sanity potions, Originite Prime and similar costs stay subject to the resource budget.

## Run panel

After confirming, the panel becomes a run panel that always has a "Stop task" button and shows status, elapsed time, progress and exit code.

- **Stop**: "Stop task" or the run panel's "×" kills this task's process tree. If it hasn't exited within 30 seconds, the panel stays "Running", shows the reason and lets you retry. MaaCore has no reliable pause, so stopping is the only option.
- **Cancel**: the confirmation panel's "×" deletes the plan and permanently invalidates its code.
- **Session isolation**: other DSH sessions see a read-only status and cannot stop the task or add conditions.
- **One at a time**: while a task runs, all new plans are refused so nothing fights over the emulator.
- **No polling**: every status read adds an entry to the conversation, so the panel reads only when expanded, refreshed or stopped. A desktop notification pops up when a task finishes, fails, or switches copilot jobs.
- **DSH restart**: on startup, leftover MAA process trees recorded in `runs.json` are terminated and their records marked "Stopped".

## Runtime instructions

While a task runs, type instructions into the panel in plain language:

```text
stop now
stop after two more runs
stop before this boss
cancel the stop request
how far has it got
```

- Run counts, floors and boss nodes are judged only from reliable MaaCore callbacks; without reliable data the status shows "unknown" and keeps waiting rather than guessing.
- A new stop condition replaces any older one that hasn't triggered.
- Requests like "recruit X first from now on" or "let me play this one" cannot take effect mid-run (maa-cli exposes no live parameter interface) and are reported as "not applied". Put them in the note of your next task instead.
