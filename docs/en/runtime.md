# Private runtime and configuration

[← Back to README](../../README.en.md)

## Private runtime

The plugin doesn't bundle MAA. On the first task it downloads one into `~/.dsh/maa-cli/runtime` (about 520–630 MB), fully isolated from any MAA already on your system. Delete the directory to uninstall it.

```text
runtime/
├─ bin/            maa-cli
├─ data/lib/       MaaCore
├─ data/resource/  resources
├─ config/         connection config default.toml
├─ state/          logs (state/debug/)
└─ runtime.json    version and install info
```

- **Install**: download the official maa-cli release → `maa-cli install` fetches MaaCore and resources → adb is detected and a config written. Without DSH you can also run `node scripts/install-runtime.mjs`.
- **Auto-update**: before a task starts, `maa-cli update` runs if 24 hours have passed since the last check, and the panel shows "updating" meanwhile. A failed update rolls back to the previous version.
- **adb detection**: `DSH_MAA_CLI_ADB_PATH` → Android SDK → common emulator install folders → `PATH`. If none is found, add `adb_path` to `default.toml` yourself (address defaults to `127.0.0.1:16384`).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DSH_MAA_CLI_RUNTIME_DIR` | Private runtime directory |
| `DSH_MAA_CLI_PATH` / `MAA_CLI_PATH` | Use a different maa-cli (errors out if it doesn't exist) |
| `DSH_MAA_CLI_ADB_PATH` | Use a specific adb |
| `DSH_MAA_CLI_STATE_DIR` | Where plans, memory and caches live (default `~/.dsh/maa-cli`) |
| `DSH_MAA_CLI_ASSET_URL` | maa-cli download URL (mirror or offline zip) |
| `DSH_MAA_NOTIFY` | Set to `0` to turn off desktop notifications |

## Compatibility

- **OS**: Windows 10/11 x64 (Linux / macOS should work but are untested)
- **Node**: 22 or later, no third-party dependencies
- **DSH**: 0.2.1-rc.3
- **Emulator**: anything adb can connect to; tested mainly on MuMu 12
- **Servers**: CN Official, Bilibili, Taiwan, and Global (EN / JP / KR)

## Safety boundaries

- Only allow-listed maa-cli subcommands are called; no arbitrary shell is run.
- It only plays the game: no purchases, no account changes, no changes to your system MAA config.
- Stopping only kills process trees this plugin recorded, and each process's command line must carry the `dsh-generated` marker, so other MAA instances are never hit.
- "The model proposes" and "you confirm" are always two separate actions.
- On unknown state, insufficient budget, or a risk of spending twice, it stops and waits for you.
