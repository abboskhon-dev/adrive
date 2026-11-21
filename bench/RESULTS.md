# Results

`bench/bench.mjs` output. Times are wall-clock per call from the Mac, over wireless adb for the phone.

## Galaxy S21, run 1

SM-G991N, Android 15 (API 35). adrive eec9d2d, Maestro 2.12.0, Appium 4.0.0.
21 calls per tool on `dev.adrive.fixture`; a call succeeds when its output contains "Mute Bass" and a timer value that differs from the previous call's.

| Tool | Read the tree | First call | Later calls, median | Later calls, p90 |
| --- | --- | --- | --- | --- |
| adrive | 21/21 | 1.13 s | 0.15 s | 0.34 s |
| adrive, `ADRIVE_NO_DAEMON=1` | 21/21 | 0.37 s | 0.62 s | 1.18 s |
| `uiautomator dump` | 0/21 | 11.18 s | 11.30 s | 11.35 s |
| `maestro hierarchy` | 21/21 | 9.57 s | 4.94 s | 5.24 s |
| `maestro mcp`, `inspect_screen` | 21/21 | 27.31 s | 0.74 s | 0.77 s |
| Appium UiAutomator2, defaults | 21/21 | 36.99 s | 10.14 s | 10.19 s |
| Appium UiAutomator2, `waitForIdleTimeout: 0` | 21/21 | 2.05 s | 0.06 s | 0.08 s |

## Galaxy S21, run 2

SM-G991N, Android 15 (API 35). adrive eec9d2d, Maestro 2.12.0, Appium 4.0.0.
21 calls per tool on `dev.adrive.fixture`; a call succeeds when its output contains "Mute Bass" and a timer value that differs from the previous call's.

| Tool | Read the tree | First call | Later calls, median | Later calls, p90 |
| --- | --- | --- | --- | --- |
| adrive | 21/21 | 0.58 s | 0.11 s | 0.19 s |
| adrive, `ADRIVE_NO_DAEMON=1` | 21/21 | 0.37 s | 0.74 s | 1.12 s |
| `uiautomator dump` | 0/21 | 11.34 s | 11.26 s | 11.36 s |
| `maestro hierarchy` | 21/21 | 30.81 s | 4.97 s | 6.00 s |
| `maestro mcp`, `inspect_screen` | 21/21 | 28.61 s | 0.75 s | 0.87 s |
| Appium UiAutomator2, defaults | 21/21 | 12.28 s | 10.15 s | 10.20 s |
| Appium UiAutomator2, `waitForIdleTimeout: 0` | 21/21 | 1.89 s | 0.05 s | 0.07 s |

## Galaxy S21, run 3

SM-G991N, Android 15 (API 35). adrive eec9d2d, Maestro 2.12.0, Appium 4.0.0.
21 calls per tool on `dev.adrive.fixture`; a call succeeds when its output contains "Mute Bass" and a timer value that differs from the previous call's.

| Tool | Read the tree | First call | Later calls, median | Later calls, p90 |
| --- | --- | --- | --- | --- |
| adrive | 21/21 | 0.38 s | 0.10 s | 0.11 s |
| adrive, `ADRIVE_NO_DAEMON=1` | 21/21 | 0.31 s | 0.47 s | 0.70 s |
| `uiautomator dump` | 0/21 | 11.18 s | 11.28 s | 11.33 s |
| `maestro hierarchy` | 21/21 | 30.14 s | 5.08 s | 5.75 s |
| `maestro mcp`, `inspect_screen` | 21/21 | 28.55 s | 0.76 s | 0.79 s |
| Appium UiAutomator2, defaults | 21/21 | 12.73 s | 10.16 s | 10.20 s |
| Appium UiAutomator2, `waitForIdleTimeout: 0` | 21/21 | 2.21 s | 0.04 s | 0.06 s |

## Android 17 emulator

Earlier check: a call succeeded when its output contained "Mute Bass", without the timer comparison.

sdk_gphone16k_arm64, Android 17 (API 37). adrive 2299aa3, Maestro 2.12.0, Appium 4.0.0.
21 calls per tool on `dev.adrive.fixture`; a call succeeds when its output contains "Mute Bass".

| Tool | Read the tree | First call | Later calls, median | Later calls, p90 |
| --- | --- | --- | --- | --- |
| adrive | 21/21 | 0.80 s | 0.10 s | 0.55 s |
| adrive, `ADRIVE_NO_DAEMON=1` | 21/21 | 0.29 s | 0.30 s | 0.33 s |
| `uiautomator dump` | 0/21 | 10.95 s | 10.94 s | 10.99 s |
| `maestro hierarchy` | 21/21 | 7.26 s | 4.69 s | 5.05 s |
| `maestro mcp`, `inspect_screen` | 21/21 | 3.82 s | 0.62 s | 0.67 s |
| Appium UiAutomator2, defaults | 21/21 | 12.69 s | 10.05 s | 10.09 s |
| Appium UiAutomator2, `waitForIdleTimeout: 0` | 21/21 | 1.56 s | 0.01 s | 0.01 s |
