import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/Markdown.js";
import {
  citationNumbers,
  markdownText,
  markdownExcerpt,
} from "../shared/markdown.js";
const render = (text) =>
  renderToStaticMarkup(
    createElement(
      Markdown,
      {
        sources: Array.from({ length: 10 }, () => ({ title: "Evidence" })),
        onCitation: () => {},
      },
      text,
    ),
  );
test("shared Markdown renders grouped citations individually, excluding code and links", () => {
  const html = render(
    "Evidence [1, 2, 10]. Code `[1, 2]` and [link](https://example.com).",
  );
  assert.equal((html.match(/class="answer-citation"/g) || []).length, 3);
  assert.match(html, /Show source 10/);
  assert.match(html, /<code>\[1, 2\]<\/code>/);
  assert.deepEqual(citationNumbers("[1, 2, 10] [2]"), [1, 2, 10]);
  assert.match(render("[99]"), /citation-unavailable/);
});
test("shared Markdown supports rich prose safely", () => {
  const html = render(
    "# Heading\n\n**bold** *italic* ~~removed~~\n\n- [x] task\n- item\n\n1. ordered\n\n> quote\n\n```js\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[unsafe](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n![remote](https://example.com/image.png)",
  );
  for (const tag of [
    "h1",
    "strong",
    "em",
    "del",
    "ul",
    "ol",
    "blockquote",
    "pre",
    "table",
  ])
    assert.ok(html.includes(`<${tag}`), tag);
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.equal(
    markdownText(
      "# Files mentioned by the user:\nfile.png\n## My request:\n**Fix** this",
    ),
    "**Fix** this",
  );
});

test("excerpt avoids unfinished table headers", () => {
  const text =
    "A substantive paragraph describing the database decisions.\n\n| Done during bulk analysis | Done when viewing a topic |\n| --- | --- |\n| one | two |";
  assert.ok(!markdownExcerpt(text, 100).includes("|"));
});
