# adrive

A small Android CLI for inspecting and driving installed apps over adb, including release builds with continuous animations. It reads the accessibility tree without calling `waitForIdle`, then uses Android input commands for actions. No changes to the app under test are required.

Compared with Maestro and other UiAutomator-based tools:

- **Never waits for idle.** Apps with looping animations, audio meters, or live canvases can be read and driven immediately instead of stalling on an idle wait.
- **Installs nothing on the device.** No driver APK or instrumentation runner; a small dex is pushed to `/data/local/tmp` and run with shell privileges.
- **Diagnoses release builds.** `perf` (CPU per thread, memory, frame jank), `audio` (track underruns, buffer sizes, output path), `crash`, and per-process `log` all work without a debuggable build.
- **Keeps accessibility services running.** TalkBack and other services stay active while the tree is read.
- **Sees other windows.** `--windows` includes the keyboard, system dialogs, and overlays with their Z-order.
- **One command, one answer.** No YAML or session to manage; the helper starts itself and exits when idle. Text output for reading, `--json` for scripts and agents. No npm dependencies.

## Setup

Requires Node.js 18+ and `adb` on your `PATH`. The helper targets Android 8 / API 26 or newer. Enable USB debugging and authorize your computer on the device.

```sh
npm install -g adb-drive
adb devices
export ANDROID_SERIAL=your-device-serial # required when multiple devices are connected
adrive help
```

The package is named `adb-drive`; the command is `adrive`. It ships a prebuilt helper dex, which is pushed to `/data/local/tmp/adrive.dex` when its contents change. `helper/Dump.java` and `build.sh` are included so you can read and rebuild it. No npm dependencies are required.

### From source

Building the helper also needs JDK 17, an Android SDK platform and build-tools (with `d8`).

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk" # use your SDK location
export PATH="$ANDROID_HOME/platform-tools:$PATH"
./build.sh
./adrive.mjs help
```

The build uses JDK 17, `android-36` and build-tools `36.0.0`, so the dex rebuilds byte for byte; its SHA-256 is printed by `./build.sh` and `adrive --version`, and listed in each GitHub release. Override with `ANDROID_PLATFORM` and `ANDROID_BUILD_TOOLS`. `ANDROID_SDK_ROOT` is accepted when `ANDROID_HOME` is unset. The dex is ignored by git; releases are built and published by CI with npm provenance and a build attestation (`gh attestation verify classes.dex --repo abboskhon-dev/adrive`). Optionally run `npm link` to install the `adrive` command.

## Examples

```sh
adrive ui
adrive ui --all --windows --json
adrive look --wait 'Ready'   # wait up to 10 s for it, then list
adrive look                  # [1] Button "Play"  [2] SeekBar ...
adrive tap @1
adrive slide @2 0.5
adrive tap 'Play' --nth 0
adrive tap 300,600
adrive longpress 'Track name'
adrive slide 'Volume' 0.75
adrive type '100% safe, including literal %s'
adrive type -- '--nth 2'
adrive swipe 300 800 300 200 500
adrive scroll down
adrive key back
adrive wait 'Ready' 10
adrive gone 'Loading' 10
adrive shot /tmp/screen.png
adrive version
adrive launch com.example.app
adrive stop com.example.app
adrive current
adrive open 'example://track?id=1&autoplay=true'
adrive log 'foo.bar' --lines 50
adrive log 'error|warning' --package com.example.app
adrive crash --package com.example.app
adrive perf --package com.example.app
adrive perf --package com.example.app --reset
adrive audio --package com.example.app --json
adrive run steps.json --package com.example.app --trace /tmp/run.perfetto-trace
adrive log-clear
adrive clear com.example.app # deletes app data and signs out
adrive daemon status
adrive daemon stop
```

Diagnostics default to the focused app. Packages are supplied only with `--package`; a dotted regex is always a regex. `crash` reports the last Java crash matching the exact package or a `package:subprocess`, plus current ANR/crashing state, not historical ANR traces or native tombstones. `log` filters the current main process PID; it does not aggregate subprocesses or logs from previous process instances. `perf` reports Android's available CPU, memory, and gfxinfo counters; gfxinfo does not measure every custom rendering pipeline. `audio` reads `dumpsys media.audio_flinger` for the app's current PIDs: live tracks, their output thread, and recently closed tracks that had underrun frames (from AudioFlinger's per-thread local log). Tracks from earlier process instances are not attributed.

`ui --wait <query>` and `look --wait <query>` wait up to 10 s for the element, then list the screen the wait saw; on a timeout they list the last screen and fail. Matching falls back to substring, so wait for text only the new screen has: `--wait Ready` also matches `Not ready`.

Element matching is case-insensitive: exact text, description, or resource ID first, then substring. Full IDs and the short suffix after `/` both work. Clickable matches are preferred within each window. `--nth` is zero-based and supported by `tap`, `longpress`, and `slide`. Missing targets fail before any device action. Use `--` before a target that starts with `--`. `type` treats its arguments as literal text (an initial `--` is an optional delimiter).

`look` numbers the elements you can act on, and `tap`, `longpress` and `slide` take `@N` from the last `look`. A ref fails without touching the device if its element moved or is gone, or if `--windows` differs from the `look`. An element with a unique resource ID keeps its ref when only its text changes, so a live label like `Downloading 42%` still works; in a pager that swaps content under the same ID, `look` again after swiping. Refs are kept per device in `~/.cache/adrive` (or `$XDG_CACHE_HOME/adrive`), so run one driver per device at a time. Until the first `look`, `@2024` is matched as text; after it, as a ref.

`tap`, `longpress`, `slide`, `type`, `swipe`, `scroll` and `key` wait up to 2 s for the screen to settle, then print what changed: `appeared: Button "Ready"`, `gone: TextView "Loading"`, `changed: TextView "taps 1" -> "taps 2"`, `changed: Switch "Mute" unchecked -> checked`, or `no change`. A label that changes more than once while the screen settles (a running clock) is left out, though a clock that ticks once a second can slip through, and `still changing after 2 s` says the layout never settled. `--quiet` prints only the action, `--json` prints the change as data; `type` takes them before an explicit `--` (`adrive type --quiet -- hello`). Steps in `run` stay quiet, so the reads don't add to the measurement.

`type` supports printable ASCII, including literal `%s`, quotes, and shell punctuation. Unicode and newlines are rejected before typing because Android's key-event based `input text` is not a general Unicode input method. Literal percent signs are sent separately to avoid Android's `%s` substitution.

## Claude Code skill

`adrive skill install` copies [`skill/SKILL.md`](skill/SKILL.md) to `~/.claude/skills/adrive` (or `$CLAUDE_CONFIG_DIR/skills/adrive`), so Claude Code can drive apps from the shell without the MCP server: `look`, act on a ref, read what changed, and take a screenshot only when the tree has nothing. Run it again after upgrading adrive; it overwrites the installed copy.

## MCP server

`adrive mcp` serves every command as a tool over stdio, for Claude Code, Cursor, and other MCP clients. `screenshot` returns the image instead of a file path, `run` takes its steps as a JSON array and returns the JSON report (with the steps measured so far when one fails); over MCP it caps waits and settle at 60 s, has no `shot` step, and saves a trace to a temporary folder whose path the report gives, and `daemon` is CLI-only. Calls run one at a time, since they share one device.

```sh
claude mcp add adrive -- adrive mcp
```

Other clients take `{"command": "adrive", "args": ["mcp"]}`. Set `ANDROID_SERIAL` in the server's environment when several devices are connected.

## Measuring a scenario

`run` takes a JSON list of steps, from a file or `-` for stdin. Each step is an adrive command as an array, or `{"do": [...], "settle": seconds}` to keep measuring for a while after the action:

```json
[["tap", "Play"], {"do": ["wait", "Ready"], "settle": 1}, ["scroll", "down"]]
```

For each step it reports frames (total, janky, p50/p90/p99 from gfxinfo), CPU time per thread from `/proc`, and PSS with its change since the previous step:

```
3 scroll down  0.48 s
  frames 86, janky 0, p50 5 ms, p90 5 ms, p99 15 ms
  cpu 270 ms (56%): RenderThread 110, .adrive.fixture 90, mali-cmar-backe 40, binder:3280_3 30
  pss 56.5 MB (-2.1)
```

Steps can be `look`, `tap`, `longpress`, `slide`, `type`, `swipe`, `scroll`, `key`, `wait`, `gone`, `shot`, `launch`, `stop` and `open`. Only the step list and command names are checked before the run starts; a step with bad arguments fails when it is reached, after the steps before it have run. The run stops at the first failing step and still reports it and the steps before it. `--json` prints the same data with each step's command output. `--trace file` records a Perfetto trace of the whole run (scheduling, frequency, graphics, views, input, binder and the app's own trace sections) to open in [ui.perfetto.dev](https://ui.perfetto.dev).

Each step's frame counts include the half second or so adrive spends reading memory between steps, while CPU covers only the step itself. CPU is only reported for the app's main process, and a thread that exits during a step loses its time. If the app restarts during a step, CPU is not reported for it.

## Windows and output

By default, inspection and matching use the active root. Add `--windows` to `ui`, `look`, `tap`, `longpress`, `slide`, `wait`, or `gone` to include interactive windows such as the keyboard. Windows retain Android's descending Z-order; exact matches still take precedence over substring matches. `--all` includes visible unlabeled/non-actionable nodes. An app must expose accessibility nodes; custom canvas pixels are not automatically recognizable controls.

`ui --json` emits the same structured data consumed internally by the CLI:

```json
{"version":1,"windows":[{"id":1,"type":1,"layer":0,"package":"com.example.app","nodes":[{"class":"android.widget.Button","text":"Play","desc":"","id":"com.example.app:id/play","clickable":true,"longClickable":false,"scrollable":false,"editable":false,"checkable":false,"checked":false,"selected":false,"enabled":true,"x":100,"y":200,"left":50,"top":150,"right":150,"bottom":250}]}]}
```

For active-root-only snapshots, `type` is `-1` and `layer` is `0` (window metadata is not queried). Text mode is one header per window and one line per node, with JSON-escaped labels. Coordinates, flags, and IDs are never parsed from those display lines.

## Compatibility and device access

The helper connects directly to Android's hidden `UiAutomation` shell entry point through reflection, with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` so existing accessibility services remain active. It does not depend on the legacy `uiautomator.jar` wrapper. This is still an internal API, not a compatibility guarantee. Failures include the Android version and a diagnostic hint; the connection is disconnected before the helper exits. Avoid concurrent automation sessions on the same device.

After the first command that reads the screen, the helper keeps running and answers later commands over a socket forwarded through adb (`localabstract:adrive`). On an Android 15 phone this takes a `ui` call from about 0.45 s to about 0.1 s. The helper exits after 30 seconds without a request; set `ADRIVE_DAEMON_IDLE=<seconds>` to change that. While it is alive it holds the device's `UiAutomation` session, so other clients of that session, such as `uiautomator dump`, fail until it exits. Run `adrive daemon stop` before using them, or set `ADRIVE_NO_DAEMON=1` to run the helper once per command. `adrive daemon status` shows whether it is running. The socket answers only the shell and root users, so apps on the device cannot read the tree or inject input through it.

While the helper is running, it also performs taps, long presses, swipes, scrolls and keys itself through `UiAutomation.injectInputEvent`, instead of starting `adb shell input` for each one; on the same phone a tap went from about 0.27 s to 0.2 s. `wait` and `gone` sleep until the helper sees the screen change, instead of re-reading every 0.3 s; they returned a median 75 ms after the label appeared instead of 350 ms. On a screen that animates they re-read at most 10 times a second. `type` and runs with `ADRIVE_NO_DAEMON=1` still use `adb shell input` and polling.

CI runs it on emulators for API 26, 29, 33, 35 and 36; it has also been run on an Android 15 phone and an Android 17 emulator. OEM builds other than Samsung's have not been verified. Test `ui`, `ui --windows --json`, and a harmless action on each target OS/OEM before relying on it. The supported public alternative is an installed instrumentation runner using `Instrumentation.getUiAutomation(flags)`, at the cost of additional setup.

The dex runs with adb shell privileges on the selected device. Use a trusted adb host; the MD5 comparison is only a cache check, not authentication. Dumps, screenshots, and logs can contain personal data. Individual adb calls have a 15-second timeout; `wait`/`gone` may overrun their requested duration by one in-flight read.

Useful references: [UiAutomation](https://developer.android.com/reference/android/app/UiAutomation), [AOSP implementation](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/app/UiAutomation.java).

Maestro provides reusable YAML test flows and CI tooling; mobile-mcp provides cross-platform agent integration; Appium supports disabling idle waits with `waitForIdleTimeout: 0`. adrive focuses on a small shell-friendly Android tool combining interaction and diagnostics.

## Benchmark

Reading the tree of an app whose label and progress bar change on every frame, on a Galaxy S21 (Android 15) over wireless adb. A call counts only if it returns the button label and a timer value newer than the previous call's. Ranges span three runs of 21 calls per tool.

| Tool | Read the tree | First call | Later calls, median |
| --- | --- | --- | --- |
| adrive | 63/63 | 0.4–1.1 s | 0.10–0.15 s |
| adrive, `ADRIVE_NO_DAEMON=1` | 63/63 | 0.3–0.4 s | 0.5–0.7 s |
| `uiautomator dump` | 0/63 | 11 s | 11 s |
| `maestro hierarchy` | 63/63 | 10–31 s | 5 s |
| `maestro mcp`, `inspect_screen` | 63/63 | 27–29 s | 0.75 s |
| Appium UiAutomator2, defaults | 63/63 | 12–37 s | 10 s |
| Appium UiAutomator2, `waitForIdleTimeout: 0` | 63/63 | 1.9–2.2 s | 0.05 s |

Only `uiautomator dump` fails on an animating screen; Maestro and Appium read it after installing their driver apps. adrive answers first, with nothing installed, while Appium with idle waits off is faster once its session is warm. First-call times for Maestro and Appium include installing their drivers when missing.

Run it yourself with `bench/fixture/build.sh`, then `ANDROID_SERIAL=<serial> node bench/bench.mjs`; set `APPIUM_URL` to include Appium. Full tables are in [`bench/RESULTS.md`](bench/RESULTS.md).

## Development

```sh
npm test
./build.sh
```

The regression tests use a fake adb and never interact with a device. They cover argument validation, shell quoting, literal text, structured matching, window order, package selection, and crash attribution.

Demo recordings, experimental overlays, the review brief, and generated helper files are local-only and ignored by git.
