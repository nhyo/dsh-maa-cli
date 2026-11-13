# dsh-maa-cli

[![npm](https://img.shields.io/npm/v/dsh-maa-cli.svg)](https://www.npmjs.com/package/dsh-maa-cli)
[![license](https://img.shields.io/npm/l/dsh-maa-cli.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/nhyo/dsh-maa-cli)

[简体中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: play *Arknights* in "one click" with natural language!

> [!TIP]
> MAA does the reliable execution; dsh-maa-cli lets it understand goals, compile strategies, remember preferences, and keep going based on real feedback.

![Say "clean up my base", confirm the plan, and MAA collects and rotates shifts on its own](docs/assets/demo-infrast.gif)

<sub>Say "clean up my base" → plan generated → confirm → MAA collects products and rotates shifts (sped up; UI in Chinese)</sub>

## What it adds over plain MAA

| | Plain MAA | dsh-maa-cli |
| --- | --- | --- |
| Giving tasks | Tick options and fill in parameters one by one | Say one sentence, get a plan, confirm to run |
| Adjusting a running task | Stop only | "Stop after two more runs", "stop before this boss", check progress any time |
| Integrated Strategies tactics | Edit resource JSON files by hand | Write it in the note — "use the special ticket on Makoto Yuki first and have him block the entrance" (noticeably raised my auto-IS win rate) — compiled and remembered |
| Custom base (RIIC) shifts | Write the schedule by hand | "All factories on Pure Gold, put XXX in the trading post" |
| Copilot jobs | Find a job yourself and check whether you have the operators | Searches jobs that fit your Box; if one fails, switches to the next |
| Operator training | None | Training advice, material gap calculation, joint farming plans |
| Goals | None | "Finish today's dailies without sanity potions", carried out step by step within budget |
| When something fails | Read the logs and judge yourself | Separates confirmed causes from guesses; retries automatically when it is safe |
| Installation | Download and configure MAA | Downloads its own isolated runtime on first use |

## Quick start

```text
dsh plugin --profile desktop add dsh-maa-cli
```

or

```text
dsh plugin --profile web add dsh-maa-cli
```

After installing, **restart DSH Desktop**, start your emulator, then try:

```text
/maa fight                                                  open the combat (sanity) panel
Clear the base, then farm 1-7 20 times                      prepare a plan in natural language
Find a low-rarity H8-4 job using operators from my Box      run a copilot job
```

The first run downloads the runtime automatically (about 520–630 MB, usually 1–3 minutes).

## Features and docs

### [Local commands and panels](docs/en/commands.md)

Everyday operations skip the model: `/maa fight`, `/maa infrast`, `/maa recruit`, `/maa rouge` and other commands open MAA-style parameter panels directly; adjust and confirm to run.

- **No model calls**: commands go through DSH's local channel and spend no tokens.
- **Remembers your last settings**: each panel remembers the parameters you last confirmed, Integrated Strategies per theme; after an MAA update only fields that became invalid fall back.
- **Runtime instructions**: while a task runs, pick "stop after this run", "stop after N more runs", "stop before this boss", "how far has it got" and more from the panel's drop-down. Run counts and floors come only from reliable MaaCore callbacks, never guesses.
- **Desktop notifications**: a notification pops up when a task finishes, fails or stops on a condition, so you don't have to keep watching.
- **Safe stopping**: stopping only kills this task's process tree and shows "Stopped" only after the processes have really exited; leftover processes are cleaned up after DSH crashes and restarts.

### [Natural language and strategies](docs/en/natural-language.md)

One sentence prepares a whole chain of tasks, e.g. "Start the game, rotate base shifts, farm 1-7 20 times, then collect rewards".

- **One model call per plan**: the confirm button runs locally; confirming does not call the model again.
- **Notes become real strategies**: write "recruit Makoto Yuki first and have him hold the front" in the note, and the plugin rewrites the IS recruitment table and auto-battle configuration that MAA actually reads, instead of just storing text. The original resources are restored afterwards.
- **Automatic placement**: "block the entrance" and "guard the protection objective" need no coordinates; the plugin computes the deployment tile and direction from map data and whether the operator is melee (ground) or ranged (high ground).
- **Strategy memory**: validated strategies are saved and reused next time, even when phrased differently; conflicting requests are never run.
- **IS panel**: theme, mode, difficulty, squad and other options are read from the current MAA resources, so new themes appear without a plugin update; difficulty defaults to "MAX", the highest available.

![A note asking to recruit Yuki Makoto first and have him block the gate is compiled into a roguelike strategy, then the run starts](docs/assets/demo-roguelike.gif)

<sub>Note: "recruit Yuki Makoto first with a Specialist voucher and have him block the gate" → compiled into a strategy → the Sarkaz roguelike run starts (sped up; UI in Chinese)</sub>

### [Daily tasks, copilot jobs and goals](docs/en/tasks.md)

- **Combat**: give only the total number of runs and MaaCore groups them automatically; drop targets such as "farm until I have 3 Orirock Clusters" are supported.
- **Today's open stages**: "farm whichever chip stage is open today", using the server's 04:00 day boundary.
- **Recruitment**: only 3★/4★ results are confirmed by default; 5★/6★ slots are skipped and you are reminded to handle them yourself.
- **Natural-language base shifts**: "all factories on Pure Gold, Vermeil in the trading post" is compiled into an MAA custom schedule; operator names are checked and ones you don't own are flagged.
- **Copilot jobs that fit your Box**: searches the MAA copilot site and marks operators you lack or haven't trained enough (e.g. S3 needs Elite 2); jobs you can field come first.
- **Automatic job switching**: if a job loses, the next job for the same stage is tried, up to 3 times, with a notification each time.
- **Goal-driven**: "I want to train Makoto Yuki — list what's missing", "I need 20 Orirock, no more than 120 sanity in total"; the plugin reads your Box and depot and proceeds step by step within budget, moving on only when each step is confirmed complete.
- **Workflow presets**: save "start game, base, visit friends, collect rewards" as a preset and reuse it with one sentence.

### [Operators and training](docs/en/operators.md)

- **Box Q&A**: after one scan, ask "which 6★ aren't Elite 2 yet" or "what potential is Wisadel"; answered from the cache without touching the emulator.
- **Training advice**: based on community tier votes and your class coverage — classes where you have no usable operator get priority.
- **Training plans**: promotion, level, skills, masteries and modules, for several operators at once, compared against your depot to find the gap.
- **"Is it enough?"**: "Does my depot have enough to promote Purestream to Elite 2?" is answered read-only.
- **Farming plans**: stage selection is jointly optimized with Penguin Statistics drop rates and ArkPlanner; it farms one batch at a time, then rescans the depot and replans, so it never overfarms on expected values.

![Ask for operator training advice; the Box is scanned and a training order is returned](docs/assets/demo-training-advice.gif)

<sub>"Give me operator training advice" → Box scan → training order by tier and class coverage (sped up; UI in Chinese)</sub>

### [Companion plugins](docs/en/extensions.md)

Optional extensions, installed on demand and never bundled with this plugin. Check their status with `/maa ext` and install one with `/maa ext install <id>`, which downloads and installs it right away.

- **[coverocr](https://github.com/nhyo/dsh-maa-coverocr)** (`dsh-maa-coverocr`, 🧪 experimental): search Bilibili with “Arknights + stage”, reading only metadata and cover images—never the video stream—or inspect links you supply. It recognizes the lineup from covers, compares it with your Box and tells you whether you can copy it (one missing operator still counts—borrow it as support). Every recommendation includes its corresponding video URL. Results may be incomplete or wrong; the video is the source of truth.

![Find Bilibili guide videos for TL-EX-8 against your Box, marking which ones you can copy](docs/assets/demo-copilot.gif)

<sub>coverocr: "find a TL-EX-8 guide that fits my Box" → video guides checked against your Box, copyable ones marked (sped up; UI in Chinese)</sub>

### [Runtime and configuration](docs/en/runtime.md)

The plugin ships its own maa-cli runtime: downloaded on first use and checked for updates once a day (the panel shows progress while updating, and a failed update rolls back). It lives in its own directory, isolated from any MAA on your system, and deleting the directory uninstalls it. This page also covers environment variables, supported systems and emulators, and what the plugin will and won't do.

### [Troubleshooting and FAQ](docs/en/troubleshooting.md)

What to do when the emulator won't connect, the runtime download fails, nothing happens after confirming, a stop fails, and more. The plugin records MaaCore callbacks, task checkpoints and ADB status, separates failure causes into "confirmed" and "inferred", and only retries scans that cannot cause duplicate spending.

### [Development](docs/en/development.md) · [Changelog](CHANGELOG.md)

Code layout, model tools, testing and release process.

## License and acknowledgements

- The plugin itself: [MIT](LICENSE).
- The runtime downloads [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights) and [maa-cli](https://github.com/MaaAssistantArknights/maa-cli) from their official sources; they follow their own licenses (MAA is AGPL-3.0).
- Thanks to the MaaAssistantArknights team for maintaining MAA and maa-cli, and to DeepSeek Harness for the plugin system.
