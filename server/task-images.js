import { randomUUID } from "node:crypto";
const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
export function pngImage(data) {
  if (
    typeof data !== "string" ||
    data.length > 5600000 ||
    data.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    fail("Choose a PNG image up to 4 MB.");
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length > 4 * 1024 * 1024 ||
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    fail("Choose a valid PNG image up to 4 MB.");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    !width ||
    !height ||
    width * height > 16000000
  )
    fail("PNG images must be at most 16 megapixels.");
  let offset = 8,
    pixels = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      type = bytes.toString("ascii", offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length)
      fail("The PNG image is incomplete.");
    if (type === "IDAT") pixels = true;
    offset += length + 12;
    if (type === "IEND") {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!pixels || !ended) fail("The PNG image is incomplete.");
  return { bytes, width, height };
}
export function taskImages(db, taskId) {
  return db
    .prepare(
      "SELECT id,name,width,height,length(data) AS bytes FROM today_task_images WHERE task_id=? ORDER BY rowid",
    )
    .all(taskId);
}
export function planTaskImages(db, taskId, items) {
  if (items === undefined) return null;
  if (!Array.isArray(items) || items.length > 4)
    fail("Attach at most four PNG images.");
  const old = new Map(taskImages(db, taskId).map((r) => [r.id, r]));
  const seen = new Set();
  let total = 0;
  const result = items.map((item) => {
    if (!item || typeof item !== "object") fail("Invalid image attachment.");
    if (item.id) {
      const existing = old.get(item.id);
      if (!existing || seen.has(item.id))
        fail("Image does not belong to this task.");
      seen.add(item.id);
      total += existing.bytes;
      return existing;
    }
    const image = pngImage(item.data);
    const name =
      typeof item.name === "string"
        ? item.name.trim().slice(0, 150)
        : "Pasted image.png";
    total += image.bytes.length;
    return {
      id: randomUUID(),
      name: name || "Pasted image.png",
      data: image.bytes,
      width: image.width,
      height: image.height,
    };
  });
  if (total > 8 * 1024 * 1024)
    fail("Images on one task must total at most 8 MB.");
  return result;
}
export function saveTaskImages(db, taskId, plan) {
  if (plan === null) return;
  const keep = new Set(plan.map((p) => p.id));
  for (const old of taskImages(db, taskId))
    if (!keep.has(old.id))
      db.prepare("DELETE FROM today_task_images WHERE id=? AND task_id=?").run(
        old.id,
        taskId,
      );
  for (const image of plan)
    if (image.data)
      db.prepare(
        "INSERT INTO today_task_images(id,task_id,name,width,height,data) VALUES(?,?,?,?,?,?)",
      ).run(
        image.id,
        taskId,
        image.name,
        image.width,
        image.height,
        image.data,
      );
}
