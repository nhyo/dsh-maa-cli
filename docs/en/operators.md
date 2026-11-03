# Operator Box, training advice and training plans

[← Back to README](../../README.en.md)

## Operator Box

`/maa box` scans the operators you own and saves them to `~/.dsh/maa-cli/operator-box.json` (ID, name, rarity, promotion, level, potential, scan time — no account information).

After a scan you can simply ask:

```text
Which 6★ operators do I have?
Which 6★ aren't Elite 2 yet?
What level and potential is Wisadel?
```

Questions are answered from the cache without connecting to the emulator. A scan that needs confirmation is prepared only when there is no cache or you ask for a refresh.

## Training advice

When you ask for training advice, DSH first shows the time of the last scan and lets you choose between the cache and a rescan. Ordering rules:

- 这是蒂蒂，她很可爱！！！ (It's Skadi — she's adorable!!!)
- Tiers come from the latest topic of the [Arknights 6★ operator strength vote](https://vote.ltsc.vip): `超大上 > 超大中 > 超大下 > 大杯 > 中杯 > 其他` (top to bottom). This is a community vote, not an official ranking.
- Classes come from MAA's bundled `battle_data.json`. If a class has no operator at Elite 1 or above, operators of that class are recommended first within the same tier.
- Only owned 6★ operators below Elite 2, or at Elite 2 below level 60, are recommended.
- The ranking is downloaded again only when the vote topic changes.

## Training plans

```text
SilverAsh and Eyjafjalla both need S2 at Mastery 3 — plan it
Does my depot have enough to promote Purestream to Elite 2?
```

- Supports promotion, level, skill level 1–7, mastery 1–3 and module 1–3, for several operators at once.
- **A Box scan does not include skill, mastery or module levels**; tell the plugin the current values — they are never assumed to be 0.
- "Is it enough?" questions are answered read-only, without creating a goal.
- Purple-and-above materials can be expanded into blue materials by workshop recipes (stock is deducted first).
- Farming plans prefer Penguin Statistics' ArkPlanner joint optimization and fall back to the lowest expected sanity per material, clearly labelled. It farms one batch at a time, then rescans the depot and replans.

Data sources: training costs from [ArknightsGamedata](https://github.com/ArknightsAssets/ArknightsGamedata), drop rates from [Penguin Statistics](https://penguin-stats.io). Both are cached locally and refreshed at most once every 24 hours; on download failure the old cache is kept. Drop rates are statistical expectations, not guarantees.
