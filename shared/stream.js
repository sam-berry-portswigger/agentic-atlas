/** Decode newline-delimited JSON across arbitrary byte boundaries, including UTF-8 splits. */
export async function readNDJSON(stream, receive) {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) receive(JSON.parse(line));
      }
      if (done) {
        if (pending.trim()) receive(JSON.parse(pending));
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Decode a JSON string as it arrives without exposing JSON syntax or incomplete escapes. */
export function partialJSONString(text, field = "answer") {
  const match = new RegExp('"' + field + '"\\s*:\\s*"').exec(text);
  if (!match) return "";
  let value = "";
  for (let i = match.index + match[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === '"') break;
    if (c !== "\\") {
      value += c;
      continue;
    }
    if (++i >= text.length) break;
    const escaped = text[i];
    if (escaped === "u") {
      const hex = text.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const escapes = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
      };
      if (!(escaped in escapes)) break;
      value += escapes[escaped];
    }
  }
  // Wait for a low surrogate instead of briefly rendering a broken emoji.
  if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  return value;
}

/** Return complete object entries from a JSON array while later entries are still arriving. */
export function partialJSONArray(text, field = "findings") {
  const match = new RegExp('"' + field + '"\\s*:\\s*\\[').exec(text);
  if (!match) return [];
  const entries = [];
  let depth = 0,
    start = -1,
    string = false,
    escaped = false;
  for (let i = match.index + match[0].length; i < text.length; i++) {
    const c = text[i];
    if (string) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') string = false;
      continue;
    }
    if (c === '"') {
      string = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    }
    if (c === "}") {
      if (--depth === 0 && start >= 0) {
        try {
          entries.push(JSON.parse(text.slice(start, i + 1)));
        } catch {}
        start = -1;
      }
    }
    if (c === "]" && depth === 0) break;
  }
  return entries;
}
