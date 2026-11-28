---
name: adrive
description: Drive and inspect an Android app on a connected device or emulator from the shell with the adrive CLI, release builds included. Use when asked to tap through an app, check what is on an Android screen, reproduce a bug on a device, or read its logs, crashes, CPU, memory or jank.
---

# Driving Android apps with adrive

`adrive` reads the screen as an accessibility tree, so text is cheaper and more exact than a screenshot. Pick the device with `ANDROID_SERIAL` if `adb devices` lists more than one.

## The loop

1. `adrive look` lists what you can act on, numbered: `[3] Button "Play"`.
2. Act on a ref from the last `look`: `adrive tap @3`, `adrive longpress @3`, `adrive slide @5 0.5`, `adrive type 'hello'` (replaces the focused field's text; any Unicode; `adrive type --append -- ' more'` to add), `adrive scroll down`, `adrive key back`.
3. Read what the action prints: `appeared: …`, `gone: …`, `changed: … -> …` or `no change`. A `left <app> -> <other>` line means the action left the app; the next commands would act on the other one. That is the new screen; don't `look` again unless you need refs for elements that just appeared.
4. Repeat. Wait for slow screens with `adrive wait 'Ready' 10`, `adrive gone 'Loading'`, or `adrive look --wait 'Ready'`.

A ref follows its element if it moved (the line says `moved from`), and fails without touching the device when it can't find the element again unambiguously; run `look` again. Without refs, `tap` also takes text, a content description, a resource id, or `x,y` (`adrive tap 540,1200`). Use `adrive tap x,y`, not `adb shell input tap`: it waits for the screen to settle and prints what changed.

## When the tree is not enough

- `adrive ui` shows every visible labelled element with bounds; `--all` adds unlabelled ones, `--windows` adds the keyboard and dialogs.
- Canvas, games and custom views have no nodes. Only then take a screenshot: `adrive shot /tmp/screen.png`, then read the image, then `tap x,y`.

## Diagnosing

- `adrive launch <package>`, `adrive stop <package>`, `adrive current`, `adrive open <url>`, `adrive reload` (React Native debug JS).
- `adrive log-clear`, do the action, then `adrive log` for the app's logcat; `adrive crash` for the last crash or ANR.
- `adrive perf --reset`, do the action, then `adrive perf` for CPU by thread, memory and jank.
- `adrive run steps.json` measures a scripted flow step by step.

`adrive help` lists every command and flag. Don't run `adrive clear <package>` unless asked: it wipes the app's data.
