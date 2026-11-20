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
