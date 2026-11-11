# Natural language and strategies

[← Back to README](../../README.en.md)

## Basic flow

Just describe what you want, e.g. "Start the game, rotate base shifts, farm 1-7 20 times, then collect the daily rewards":

1. The model calls `maa_prepare_plan` once and produces an ordered plan.
2. A confirmation panel appears above the input box, where you can adjust parameters and add a note; in a multi-step plan, each step can be opened and edited on its own.
3. Click "Confirm and run MAA" to run it locally — **no further model calls**.

Confirmation codes are valid only in the current session, single-use, and expire after 30 minutes; they survive a DSH restart.

## Notes

The note field on the confirmation panel takes extra requests (e.g. "recruit Makoto Yuki first and have him block the entrance"). It is parsed automatically when you leave the field:

- local rules and strategy memory compile it first;
- only the parts they can't resolve go to the model to be normalized (fixing typos, reading 抓/拿/捞/选 — "grab/take/pick" — all as "recruit"), then compiled locally again;
- you can confirm only after parsing succeeds; anything that can't be executed is explained.

## Strategy compilation

IS and combat strategies are compiled into resource or job files that MAA **actually reads**, not stored as text.

Supported:

- change an IS operator's recruitment, skill and Elite 2 priority; operators missing from the recruitment table are validated and added
- reset the starting squad conditions
- reorder or ban collectible purchases
- change preferred options for known events
- generate Copilot deploy, skill and retreat actions with coordinates, direction, cost, delay and kill-count conditions
- "block the entrance" / "guard the protection objective": without a stage name, placement and direction are chosen automatically for every stage of the theme (from map data and whether the operator is ground or high-ground)
- several requests in one sentence

Safety and fallback:

- IS strategies are applied as a temporary overlay through maa-cli's `--user-resource`: backed up before the run and restored afterwards; MAA's original resources stay read-only.
- Operators, collectibles, events or stages that don't exist are never guessed; they are listed with the reason.
- Copilot is pre-scripted actions, not a real-time tactical AI; requests that need on-the-spot judgement are explained as not possible.

## Strategy memory

Validated strategies are saved as minimal units in `~/.dsh/maa-cli/strategy-memory.json`:

- what is saved is the normalized MAA action, not your sentence, so different wordings of the same thing hit the same memory.
- at most 20 entries per category; conflicting requests are neither run nor saved; an explicit instruction now overrides an older preference.
- before reuse, version, theme and map are checked and a preview is rerun; "block the entrance" saves no coordinates and is recomputed for the current map every time.
- the model can list and manage entries with `/maa strategies` and `/maa strategy-enable|disable|delete`.

## Auto Integrated Strategies panel

When a plan contains an IS step, the confirmation panel shows "Auto IS parameters": theme, mode, difficulty, number of runs, squad, role group, starting operator and support unit.

- Options are read from the current MAA resources; after a resource update the panel refreshes every 15 seconds, no DSH restart needed.
- Difficulty defaults to "MAX", resolved to the theme's highest difficulty when confirming. Number of runs defaults to 9999.
- Each theme remembers its own last confirmed settings.
- "Advanced settings" shows only the switches MAA actually uses for the current theme and mode:

| Switch | Shown when |
| --- | --- |
| Use non-friend support | Using support |
| Stop at final boss | Theme is not Phantom |
| Stop at max level, invest Originium Ingots | Always |
| Investment count, stop when investment is full | Investing |
| Shop after investing | Ingot farming mode |
| Reroll for Elite 2 start, only reroll for Elite 2 | Starting-squad reroll mode |
| Auto-iterate monthly squad / deep investigation | Matching mode |
| Leisure node target | Leisure node farming mode |
| Use Foldartals, detect collapsal paradigms | Sami |
| Refresh shop with dice | Mizuki |

Manual confirmation can carry parameters too, e.g. `/maa confirm MAA-1A2B3C theme=Sarkaz mode=0 difficulty=4`.
