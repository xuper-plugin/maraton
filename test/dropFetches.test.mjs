// Kino waits for every request a call left running before it delivers the call's answer; the plugin asks Kino to drop them once the call settles.
import test from "node:test";
import assert from "node:assert/strict";

test("the plugin asks Kino to drop the requests a call leaves running", async () => {
  delete globalThis.__kinoDropPendingFetches;
  await import("../plugin.js?src=" + Date.now());
  assert.equal(globalThis.__kinoDropPendingFetches, true);
});
