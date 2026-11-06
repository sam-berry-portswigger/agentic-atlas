import test from "node:test";
import assert from "node:assert/strict";
import { imageHistoryShortcut } from "../shared/image-shortcuts.js";

const shortcut = (key, options = {}) =>
  imageHistoryShortcut({ key, ...options });

test("image history shortcuts include Mac and Windows undo and redo", () => {
  assert.equal(shortcut("z", { metaKey: true }), "undo");
  assert.equal(shortcut("Z", { ctrlKey: true }), "undo");
  assert.equal(shortcut("z", { metaKey: true, shiftKey: true }), "redo");
  assert.equal(shortcut("z", { ctrlKey: true, shiftKey: true }), "redo");
  assert.equal(shortcut("y", { ctrlKey: true }), "redo");
  assert.equal(shortcut("y", { metaKey: true }), null);
  assert.equal(shortcut("z", { metaKey: true, altKey: true }), null);
});

test("native undo remains available while editing text", () => {
  for (const selector of ["input", "textarea", "[contenteditable='true']"]) {
    const target = { closest: (query) => query.includes(selector) };
    assert.equal(shortcut("z", { metaKey: true, target }), null);
  }
  assert.equal(
    shortcut("z", { ctrlKey: true, target: { isContentEditable: true } }),
    null,
  );
  assert.equal(shortcut("z", { metaKey: true, isComposing: true }), null);
  assert.equal(shortcut("z", { metaKey: true, defaultPrevented: true }), null);
});
