# Changelog

User-visible changes, newest first. `## Unreleased` at the top is the section in progress; a
release retitles it `## <version> — <date>`.

## Unreleased

### Added

- **The helper stays running between commands** (#6)
  - Commands that read the screen take about 0.1 s instead of 0.45 s after the first one.
  - It exits after 30 s idle (`ADRIVE_DAEMON_IDLE`); `ADRIVE_NO_DAEMON=1` runs it once per command.
  - `adrive daemon status|stop`; stop frees the device for `uiautomator dump` and other tools.
- **Install from npm without a JDK or Android SDK** (#2)
  - `npm install -g adb-drive` ships a prebuilt helper dex; the command is still `adrive`.
  - The package is renamed `adb-drive`, since `adrive` is taken on npm.

### Fixed

- **Commands that read the screen work on Android 17** (#5)
  - The helper was killed when `UiAutomation` connected; it now prepares the main looper first.

### Internal

- Contributing guide, changelog, issue and PR templates (#3).
