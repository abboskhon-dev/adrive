# Changelog

User-visible changes, newest first. `## Unreleased` at the top is the section in progress; a
release retitles it `## <version> — <date>`.

## Unreleased

### Added

- **Refs follow a moved element** (#46)
  - `tap @N` and the other ref commands act at the element's new position when it moved but is still the only actionable element with the same class and label in its window, and say it moved. Elements inside scrolling lists are not followed.
- **Actions print what changed** (#47)
  - `tap`, `longpress`, `slide`, `type`, `swipe`, `scroll` and `key` wait for the screen to settle, then print `appeared:`, `gone:` and `changed:` lines; `--json` prints them as data and `--quiet` skips them.
  - `left <app> -> <other>` says the action took you out of the app.
- **Verifiable releases** (#32)
  - Releases are published from CI with npm provenance and a build attestation for the helper dex.
  - The helper dex rebuilds byte for byte; `adrive --version` prints its SHA-256.
- **Claude Code skill** (#23)
  - `adrive skill install` adds a skill that teaches Claude Code the `look`, act, read-the-change loop from the shell.
- **`ui --wait` and `look --wait`**
  - `--wait <query>` waits up to 10 s for an element to appear before reading the screen, so a read right after an action doesn't return the old screen. On a timeout it still lists the last screen.

## 0.1.0 — 2026-11-22

First release.

### Added

- **Drive and inspect any installed app over adb, release builds included**
  - Reads the accessibility tree without waiting for idle, so apps that never stop animating still work.
  - `ui`, `tap`, `longpress`, `slide`, `type`, `swipe`, `scroll`, `key`, `wait`, `gone`, `shot`, `launch`, `stop`, `current`, `open`, `clear`, `version`.
  - Diagnostics without a debuggable build: `log`, `crash`, `perf` and `audio`.
  - Runs on Android 8 (API 26) and newer, including Android 17 (#5).
- **Faster actions and waits** (#18)
  - Taps, swipes, scrolls and keys go through the running helper instead of `adb shell input`: about 65 ms faster per tap.
  - `wait` and `gone` return as soon as the screen changes: a median 75 ms after the label appears instead of 350 ms.
- **MCP server** (#15, #17)
  - `adrive mcp` serves every command as a tool over stdio; `screenshot` returns the image.
  - `run` is a tool too: it takes steps as JSON and returns the per-step report.
- **Measure a scenario step by step with `adrive run`** (#16)
  - Runs a JSON list of commands and reports frames, jank, CPU per thread and memory for each step.
  - `--trace` records a Perfetto trace of the whole run; `--json` for scripts and agents.
- **The helper stays running between commands** (#6)
  - Commands that read the screen take about 0.1 s instead of 0.45 s after the first one.
  - It exits after 30 s idle (`ADRIVE_DAEMON_IDLE`); `ADRIVE_NO_DAEMON=1` runs it once per command.
  - `adrive daemon status|stop`; stop frees the device for `uiautomator dump` and other tools.
- **Install from npm without a JDK or Android SDK** (#2)
  - `npm install -g adb-drive` ships a prebuilt helper dex; the command is `adrive`.

### Internal

- Contributing guide, changelog, issue and PR templates (#3).
- Benchmark of tree reads against `uiautomator dump`, Maestro and Appium on an animating app, with results in the README (#14).
- CI: tests on Node 18–24 (Linux, macOS), helper build, and an emulator smoke test on API 26, 29, 33, 35 and 36 (#19).
