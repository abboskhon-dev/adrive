# adrive

A small Android CLI for inspecting and driving installed apps over adb, including release builds with continuous animations. It reads the accessibility tree without calling `waitForIdle`, then uses Android input commands for actions. No changes to the app under test are required.

Compared with Maestro and other UiAutomator-based tools:

- **Never waits for idle.** Apps with looping animations, audio meters, or live canvases can be read and driven immediately instead of stalling on an idle wait.
- **Installs nothing on the device.** No driver APK or instrumentation runner; a small dex is pushed to `/data/local/tmp` and run with shell privileges.
- **Diagnoses release builds.** `perf` (CPU per thread, memory, frame jank), `audio` (track underruns, buffer sizes, output path), `crash`, and per-process `log` all work without a debuggable build.
- **Keeps accessibility services running.** TalkBack and other services stay active while the tree is read.
- **Sees other windows.** `--windows` includes the keyboard, system dialogs, and overlays with their Z-order.
- **One command, one answer.** No YAML, server, or session to manage; text output for reading, `--json` for scripts and agents. No npm dependencies.

## Setup

Requires Node.js 18+, JDK 17+, Android SDK platform-tools, an SDK platform and build-tools (with `d8`). The helper targets Android 8 / API 26 or newer. Enable USB debugging and authorize your computer on the device.

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk" # use your SDK location
export PATH="$ANDROID_HOME/platform-tools:$PATH"
./build.sh
adb devices
export ANDROID_SERIAL=your-device-serial # required when multiple devices are connected
./adrive.mjs help
```

The build selects the highest numeric installed platform and build-tools versions. Override with `ANDROID_PLATFORM=android-36 ANDROID_BUILD_TOOLS=36.0.0 ./build.sh`. `ANDROID_SDK_ROOT` is accepted when `ANDROID_HOME` is unset. The dex is built locally, ignored by git, and pushed to `/data/local/tmp/adrive.dex` when its contents change. No npm dependencies are required. Optionally run `npm link` to install the `adrive` command.

## Examples

```sh
adrive ui
adrive ui --all --windows --json
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
adrive log-clear
adrive clear com.example.app # deletes app data and signs out
```

Diagnostics default to the focused app. Packages are supplied only with `--package`; a dotted regex is always a regex. `crash` reports the last Java crash matching the exact package or a `package:subprocess`, plus current ANR/crashing state, not historical ANR traces or native tombstones. `log` filters the current main process PID; it does not aggregate subprocesses or logs from previous process instances. `perf` reports Android's available CPU, memory, and gfxinfo counters; gfxinfo does not measure every custom rendering pipeline. `audio` reads `dumpsys media.audio_flinger` for the app's current PIDs: live tracks, their output thread, and recently closed tracks that had underrun frames (from AudioFlinger's per-thread local log). Tracks from earlier process instances are not attributed.

Element matching is case-insensitive: exact text, description, or resource ID first, then substring. Full IDs and the short suffix after `/` both work. Clickable matches are preferred within each window. `--nth` is zero-based and supported by `tap`, `longpress`, and `slide`. Missing targets fail before any device action. Use `--` before a target that starts with `--`. `type` treats its arguments as literal text (an initial `--` is an optional delimiter).

`type` supports printable ASCII, including literal `%s`, quotes, and shell punctuation. Unicode and newlines are rejected before typing because Android's key-event based `input text` is not a general Unicode input method. Literal percent signs are sent separately to avoid Android's `%s` substitution.

## Windows and output

By default, inspection and matching use the active root. Add `--windows` to `ui`, `tap`, `longpress`, `slide`, `wait`, or `gone` to include interactive windows such as the keyboard. Windows retain Android's descending Z-order; exact matches still take precedence over substring matches. `--all` includes visible unlabeled/non-actionable nodes. An app must expose accessibility nodes; custom canvas pixels are not automatically recognizable controls.

`ui --json` emits the same structured data consumed internally by the CLI:

```json
{"version":1,"windows":[{"id":1,"type":1,"layer":0,"package":"com.example.app","nodes":[{"class":"android.widget.Button","text":"Play","desc":"","id":"com.example.app:id/play","clickable":true,"longClickable":false,"scrollable":false,"editable":false,"checkable":false,"checked":false,"selected":false,"enabled":true,"x":100,"y":200,"left":50,"top":150,"right":150,"bottom":250}]}]}
```

For active-root-only snapshots, `type` is `-1` and `layer` is `0` (window metadata is not queried). Text mode is one header per window and one line per node, with JSON-escaped labels. Coordinates, flags, and IDs are never parsed from those display lines.

## Compatibility and device access

The helper connects directly to Android's hidden `UiAutomation` shell entry point through reflection, with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` so existing accessibility services remain active. It does not depend on the legacy `uiautomator.jar` wrapper. This is still an internal API, not a compatibility guarantee. Failures include the Android version and a diagnostic hint; the connection is disconnected before the helper exits. Avoid concurrent automation sessions on the same device.

The revised helper compiles locally; Android 15/16 runtime support has not yet been verified on devices. Test `ui`, `ui --windows --json`, and a harmless action on each target OS/OEM before relying on it. The supported public alternative is an installed instrumentation runner using `Instrumentation.getUiAutomation(flags)`, at the cost of additional setup.

The dex runs with adb shell privileges on the selected device. Use a trusted adb host; the MD5 comparison is only a cache check, not authentication. Dumps, screenshots, and logs can contain personal data. Individual adb calls have a 15-second timeout; `wait`/`gone` polling may overrun their requested duration by one in-flight adb call.

Useful references: [UiAutomation](https://developer.android.com/reference/android/app/UiAutomation), [AOSP implementation](https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/app/UiAutomation.java).

Maestro provides reusable YAML test flows and CI tooling; mobile-mcp provides cross-platform agent integration; Appium supports disabling idle waits with `waitForIdleTimeout: 0`. adrive focuses on a small shell-friendly Android tool combining interaction and diagnostics.

## Development

```sh
npm test
./build.sh
```

The regression tests use a fake adb and never interact with a device. They cover argument validation, shell quoting, literal text, structured matching, window order, package selection, and crash attribution.

Demo recordings, experimental overlays, the review brief, and generated helper files are local-only and ignored by git.
