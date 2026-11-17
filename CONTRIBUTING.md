# Contributing

Issues and pull requests are welcome.

## Setup

Requires Node.js 18+, JDK 17+ and an Android SDK with platform-tools, a platform and build-tools
(see the [README](./README.md#setup)).

```sh
./build.sh    # compile the device helper to helper/build/classes.dex
npm test      # CLI tests against a fake adb; no device needed
```

## Where things live

- `adrive.mjs`: the CLI. Argument parsing, element matching, adb calls, diagnostics parsers.
- `helper/Dump.java`: the on-device helper that reads the accessibility tree. Built by `build.sh`.
- `test/cli.test.mjs`: regression tests. They never touch a device.

## Issues

Open an issue before a big pull request, and link it from the PR (`Closes #123`). A change is big
when it does any of these:

- adds a command or a new diagnostic;
- changes an existing command's arguments, matching rules, text output or `--json` shape;
- changes what the helper does on the device: the hidden APIs it calls, what it pushes, what it
  runs with shell privileges.

Small fixes, tests, docs and refactors don't need an issue. Agreeing on the approach in the issue
first saves a rewrite in review.

## Pull requests

- Name the branch `feat/<slug>` when it adds or changes behaviour, or `chore/<slug>` for tooling,
  CI, docs and housekeeping. If it does both, use `feat/`.
- Fill in the PR template: summary, evidence, merge danger.
- Keep each PR to one change, and add a test when you fix a bug in `adrive.mjs`.
- The tests use a fake adb, so anything that changes device behaviour also needs a real run. Say
  what you ran it on: device or emulator, Android version, build type of the app.
- Never commit an app ID, device serial, screenshot, dump or log from a real device.

## Versions

The package follows [semantic versioning](https://semver.org). Until 1.0, a minor version may
break the CLI and a patch never does.

The `ui --json` output carries its own `version`. Adding a field keeps the number; removing or
renaming a field, or changing what one means, bumps it.
