/** Calendar boundaries in the user's local timezone; end is exclusive. */
export function dateRange(
  preset = "all",
  from = "",
  to = "",
  now = new Date(),
) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(day);
  tomorrow.setDate(day.getDate() + 1);
  let start = null,
    end = null;
  if (preset === "today") {
    start = day;
    end = tomorrow;
  }
  if (preset === "week") {
    start = new Date(day);
    start.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    end = tomorrow;
  }
  if (preset === "7days") {
    start = new Date(day);
    start.setDate(day.getDate() - 6);
    end = tomorrow;
  }
  if (preset === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = tomorrow;
  }
  if (preset === "custom") {
    const parse = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const [y, m, d] = value.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      return date.getFullYear() === y &&
        date.getMonth() === m - 1 &&
        date.getDate() === d
        ? date
        : null;
    };
    start = parse(from);
    const last = parse(to);
    if (!start || !last || last < start)
      return {
        start: "",
        end: "",
        error: "Choose a valid start and end date.",
      };
    end = new Date(last);
    end.setDate(end.getDate() + 1);
  }
  return {
    start: start?.toISOString() || "",
    end: end?.toISOString() || "",
    error: "",
  };
}
