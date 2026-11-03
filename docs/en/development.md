# Development

[← Back to README](../../README.en.md)

```bash
npm test   # node --test, no third-party dependencies
```

## Layout

| Path | Responsibility |
| --- | --- |
| `src/index.js` | Entry: registers tools and the `/maa` command, ties confirmation to execution |
| `src/client/` | Panel UI |
| `src/capabilities/` | Discovers capabilities from the current MAA version and resources |
| `src/commands/` | Command parsing, task planning, confirmation codes, run records |
| `src/runtime/` | maa-cli calls, private runtime, diagnostics, desktop notifications |
| `src/operators/` | Operator Box, depot, training advice |
| `src/agent/` | Goals, workflows, training data, failure diagnosis and recovery |
| `src/strategy/` | Strategy compilation and memory, IS resource overlays, Copilot, base schedules, copilot site |
| `test/` | All tests |
| `scripts/` | Scripts that run without DSH |

`test/panel-lifecycle.test.mjs` is the end-to-end panel test: the real entry point acts as the host, a fake maa-cli produces a real process tree, and a minimal React renderer renders the real panels and clicks them. It doesn't connect to an emulator and can't replace testing on a real device.

## Model tools

| Tool | Purpose |
| --- | --- |
| `maa_prepare_plan` | Natural language → plan + confirm button |
| `maa_prepare_strategy` / `maa_prepare_note` | Strategy or note → MAA resources or Copilot job |
| `maa_prepare_infrast` | Custom base schedule |
| `maa_copilot` | Search the copilot site / prepare a job |
| `maa_runtime_instruction` | Add stop conditions or query progress while running |
| `maa_operator_box` / `maa_depot` | Read-only Box / depot cache queries |
| `maa_training_advice` | Training advice |
| `maa_goal_manager` / `maa_workflow_manager` | Goals and workflows |
| `maa_stage_schedule` | Weekly stages open today |
| `maa_query` | Read-only maa-cli version and directory queries |
| `maa_doctor` | Environment health check |
| `maa_runtime` | Inspect, install or update the private runtime |

## Release

```bash
npm test && git commit -am "release: <version>" && npm publish && git tag -a v<version> -m "<version>" && git push origin main --tags
```

Before releasing, bump the version in `package.json`, update the CHANGELOG, and make sure `npm whoami` shows you are logged in. Chaining with `&&` stops at the first failing step.
