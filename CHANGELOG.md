# Changelog

## 0.6.6

- Home (and every call) leaves at its own budget: Kino waits for every request a call left running before it delivers the answer, so a Home that skipped a slow row was still held until that request ended or retried (measured on users' devices: Home ran 21-34 s with rows logged as skipped, and Kino threw the answer away at 20 s). The plugin now asks Kino to drop what a call leaves running (`globalThis.__kinoDropPendingFetches = true`, read by Kino 0.9.55 and later; an older Kino ignores it), with a test (`test/dropFetches.test.mjs`).
