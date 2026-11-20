# Changelog

User-visible changes, newest first. `## Unreleased` at the top is the section in progress; a
release retitles it `## <version> — <date>`.

## Unreleased

### Added

- **Install from npm without a JDK or Android SDK** (#2)
  - `npm install -g adb-drive` ships a prebuilt helper dex; the command is still `adrive`.
  - The package is renamed `adb-drive`, since `adrive` is taken on npm.

### Fixed

- **Commands that read the screen work on Android 17** (#5)
  - The helper was killed when `UiAutomation` connected; it now prepares the main looper first.

### Internal

- Contributing guide, changelog, issue and PR templates (#3).
