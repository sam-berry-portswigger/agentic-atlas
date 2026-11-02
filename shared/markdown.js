/** Clean transport wrappers without flattening Markdown or changing evidence. */
export function markdownText(value = "") {
  let text = String(value);
  if (/^\s*# Files (?:mentioned by|pasted by) the user:/i.test(text)) {
    const marker = /(?:^|\n)## My request:\s*/i.exec(text);
    if (!marker) return "";
    text = text.slice(marker.index + marker[0].length);
  }
  return text
    .replace(
      /<\/?(?:pasted_content|excerpts|conversations|work_item)\b[^>]*>/gi,
      "",
    )
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "")
    .trim();
}
export function markdownExcerpt(value, max = 320) {
  const text = markdownText(value);
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  const lastBlock = head.lastIndexOf("\n\n");
  // An excerpt ending halfway through a table header has no Markdown
  // separator yet. Omit that unfinished block rather than displaying pipes.
  const tail = head.slice(lastBlock + 2);
  if (lastBlock > 0 && /^\s*\|/.test(tail) && !/\n\s*\|?[ :|-]*---/.test(tail))
    head = head.slice(0, lastBlock);
  const boundary = head.lastIndexOf(" ");
  return (boundary > max * 0.6 ? head.slice(0, boundary) : head) + "…";
}
/** Convert numeric citation groups to individual inline links outside code/links. */
export function remarkCitations() {
  return (tree) => {
    function walk(node) {
      if (
        [
          "code",
          "inlineCode",
          "link",
          "linkReference",
          "definition",
          "html",
        ].includes(node.type) ||
        !node.children
      )
        return;
      const children = [];
      for (const child of node.children) {
        if (child.type !== "text") {
          walk(child);
          children.push(child);
          continue;
        }
        const text = child.value;
        let end = 0;
        for (const match of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
          if (match.index > end)
            children.push({
              type: "text",
              value: text.slice(end, match.index),
            });
          const numbers = [
            ...new Set(
              match[1].split(",").map((value) => Number(value.trim())),
            ),
          ];
          numbers.forEach((number, i) => {
            if (i) children.push({ type: "text", value: " " });
            children.push({
              type: "link",
              url: `#atlas-citation-${number}`,
              data: { hProperties: { "data-citation": number } },
              children: [{ type: "text", value: String(number) }],
            });
          });
          end = match.index + match[0].length;
        }
        if (end < text.length)
          children.push({ ...child, value: text.slice(end) });
      }
      node.children = children;
    }
    walk(tree);
  };
}

export function citationNumbers(text) {
  return [
    ...new Set(
      [...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((match) =>
        match[1].split(",").map(Number),
      ),
    ),
  ];
}
