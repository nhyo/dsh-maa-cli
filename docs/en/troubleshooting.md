# Troubleshooting and FAQ

[← Back to README](../../README.en.md)

When something goes wrong, first have DSH run a health check (`maa_doctor`); it checks 9 items including maa-cli, directories, connection config and the ADB port.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "请手动启动mumu模拟器！" (please start MuMu manually) | Start the emulator (with ADB enabled) and click confirm again; the plan stays valid |
| adb can't connect | Check with `adb devices`; MuMu needs ADB enabled in its settings, default port `16384` |
| `os error 17` (cannot move the file to a different disk drive) | The directory is EFS-encrypted. Decrypt it with `cipher /d`, or point it to an unencrypted drive with `mklink /J` |
| Runtime download slow or failing | Set `DSH_MAA_CLI_ASSET_URL` to a mirror or offline zip |
| Nothing happens for a long time after confirming | The daily MaaCore update may be running (about 1 minute); the panel shows "updating" |
| Panel stays on "Running" | It normally refreshes every 3 seconds; if it doesn't change, click "Refresh status", or restart DSH Desktop so the new plugin version loads |
| "Stop failed" | The process didn't exit within 30 seconds (e.g. blocked by security software); just retry |
| "An MAA task is already running" | Only one task can run at a time; stop it or wait for it to finish |
| "Belongs to another DSH session" | Go back to the session that started the task |
| Confirmation code invalid | Codes are single-use and expire after 30 minutes; prepare the plan again |
| Plugin updated but behaviour unchanged | Restart DSH Desktop |

## FAQ

**Do I need to install MAA first? Will it affect my existing MAA?**
No, and no. The plugin is isolated from your system MAA by its own directory and environment variables.

**Why isn't MAA bundled with the plugin?**
MaaCore and its resources are several hundred MB, and MAA is AGPL-3.0. Downloading on demand keeps the plugin light and makes it easy to follow upstream updates.

**Can I pause a task?**
No — MaaCore has no reliable pause. You can stop immediately, or set it to stop at the end of this run, after N more runs, or before a boss.

**Where are the logs?**
`~/.dsh/maa-cli/runtime/state/debug/`, or ask DSH to query `log_dir` with `maa_query`.
