# Companion plugins

Companions are installed on demand and are not bundled with dsh-maa-cli. Use `/maa ext` to check their status and `/maa ext install <id>` to install one directly.

## coverocr

`dsh-maa-coverocr` is an experimental companion that searches Bilibili with “Arknights + stage”, or inspects supplied video links. It only reads metadata and cover images—never playback URLs or video streams—recognizes operators on the cover with MAA's OCR models, and compares ownership with your Box. Every recommendation must include its corresponding video URL.

```text
/maa ext install coverocr
```

Search depends on Bilibili's undocumented web endpoints and cover-only recognition may be incomplete or wrong. The returned links are for the user to open and follow manually.

The companion persists and reuses its anonymous Bilibili session and WBI keys, serializes all requests, and applies a restart-safe escalating cooldown after repeated risk-control responses. A signed request refreshes WBI and retries only once before cooldown begins.
