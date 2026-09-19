// Minimal ZIP reader for the self-updater (no dependencies).
// Reads the central directory (so data-descriptor zips work), supports
// "stored" (0) and "deflate" (8) entries via the browser's DecompressionStream.
// Returns [{ path, data: Uint8Array }] for files (directories are skipped).

export async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => view.getUint16(o, true);
  const u32 = (o) => view.getUint32(o, true);

  // End of central directory record: signature 0x06054b50, searched from the end
  // (it may be followed by a comment of up to 64 KB).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end-of-directory record).");
  const count = u16(eocd + 10);
  let p = u32(eocd + 16); // central directory offset

  const decoder = new TextDecoder("utf-8");
  const out = [];
  for (let n = 0; n < count; n++) {
    if (u32(p) !== 0x02014b50) throw new Error("Corrupt zip (central directory).");
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOff = u32(p + 42);
    // Windows tools may write backslashes; normalise to "/".
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue; // directory entry

    if (u32(localOff) !== 0x04034b50) throw new Error("Corrupt zip (local header for " + path + ").");
    const start = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error("Unsupported compression method " + method + " for " + path);
    out.push({ path, data });
  }
  return out;
}

async function inflateRaw(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A path is safe to write inside the extension folder: relative, no "..",
// no drive letters or absolute roots.
export function isSafePath(path) {
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((seg) => seg && seg !== "." && seg !== "..");
}
