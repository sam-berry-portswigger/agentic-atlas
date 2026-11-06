export const topicColors = [
  "#a28bdb",
  "#e4a675",
  "#83b6d9",
  "#81b7a0",
  "#d884a3",
  "#c4bc6c",
  "#86b8be",
  "#ad9b88",
  "#c18dc1",
  "#80a6d0",
  "#c29978",
  "#92ae77",
  "#c98186",
  "#8f9acb",
  "#70a9a0",
  "#b5a46e",
  "#9b78ac",
  "#6f9db1",
  "#c48e65",
  "#7ca184",
  "#b77a9b",
  "#a5ae62",
  "#779aaa",
  "#a58c78",
];

// Preserve established colors; additional genuine goals must not fail because
// the initial palette has 24 entries. Generated colors are deterministic hex.
export function nextTopicColor(used) {
  const available = topicColors.find((color) => !used.has(color));
  if (available) return available;
  for (let index = 0; ; index++) {
    const hue = ((index * 137.508) % 360) / 60;
    const chroma = 0.38,
      x = chroma * (1 - Math.abs((hue % 2) - 1)),
      m = 0.43;
    const rgb =
      hue < 1
        ? [chroma, x, 0]
        : hue < 2
          ? [x, chroma, 0]
          : hue < 3
            ? [0, chroma, x]
            : hue < 4
              ? [0, x, chroma]
              : hue < 5
                ? [x, 0, chroma]
                : [chroma, 0, x];
    const color =
      "#" +
      rgb
        .map((channel) =>
          Math.round((channel + m) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    if (!used.has(color)) return color;
  }
}
