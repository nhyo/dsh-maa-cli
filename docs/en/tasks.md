# Daily tasks, copilot jobs and goals

[← Back to README](../../README.en.md)

```text
Farm 1-7 with two sanity potions, no Originite Prime
Farm 3 Orirock Clusters
Farm whichever chip stage is open today
Recruit 4 times, tell me if a 5★ or higher shows up
All factories on Pure Gold, Vermeil in the trading post
Find a low-rarity H8-4 job and run it
Finish today's dailies without Originite Prime or sanity potions
```

Originite Prime and sanity potions are never used unless you ask.

## Combat

- Give only the total number of runs; MaaCore groups them automatically (at most 100 per command).
- **Drop targets**: "farm 3 Orirock Clusters" stops as soon as any target is reached; in the panel write `固源岩组=3；装置=2` (item names as in the CN game data).
- **Annihilation**: you can ask for it, but the plugin cannot tell whether this week's cap is already reached.
- **Weekly stages**: `maa_stage_schedule` lists today's open resource and chip stages by server day (04:00 boundary); choosing a closed stage gives a warning.

## Recruitment

Same defaults as MAA: 4 recruitments, auto-confirming 3★/4★. **5★/6★ are never auto-confirmed** — the slot is skipped and the run panel and result remind you to handle it.

## Base schedules

`maa_prepare_infrast` compiles a natural-language schedule into an MAA custom schedule:

- operator names are checked; unknown, duplicate or over-capacity assignments are listed as "not applied". With a Box cache, operators you don't own are flagged.
- facilities you don't mention use MAA's default algorithm.
- **MAA does not switch production lines**; it only picks operators for what a room currently produces.
- schedules can be saved, reused and deleted.

## Copilot jobs

`maa_copilot` searches the [MAA copilot site](https://prts.plus) and ranks jobs against your Box:

- it marks operators you lack or haven't trained enough (S2 needs Elite 1, S3 needs Elite 2, plus whatever the job requires); jobs you can fully field come first. Without a Box cache it says it can't tell.
- the confirmation panel shows title, author, required and missing operators. Stationary Security Service jobs use SSS mode automatically.
- **Automatic job switching**: for jobs where MAA navigates to the stage itself, up to 3 backup jobs for the same stage that your Box can field are picked when preparing. Only a failure of the job itself triggers a switch (not emulator disconnects or a manual stop), and every switch pops up a desktop notification. `autoSwitch: false` turns it off.

Generated schedule and job files exist only while the task runs and are deleted afterwards.

## Goals and workflows

You can state a goal directly; the plugin reads your Box and depot caches and plans budget-bound steps:

```text
I want to train Makoto Yuki — read my Box and depot first, list what's missing, don't farm yet.
I need 20 Orirock; if the depot is short, plan 1-7, but no more than 120 sanity in total.
Save "start game, base, visit friends, collect rewards" as a workflow for next time.
```

- Goals are stored in `goals.json`, workflow presets in `workflows.json`.
- Each step runs on its own and the next starts only when the log confirms completion; when all steps are done the goal waits for verification — "the process exited" is never treated as "the goal was achieved".
- With `maxSanity` set, a plan whose estimated sanity exceeds the budget is blocked before running.

## Failure recovery

- Failure causes are recorded in `runs.json`, split into "confirmed" and "inferred", and visible in the run panel.
- Only Box / depot scans that haven't completed any step are retried automatically (up to 2 times); combat, recruitment, shopping, rewards and base tasks are never blindly replayed.
- If DSH exits mid-run, the running workflow is marked for review and uncertain steps are not resumed automatically.
