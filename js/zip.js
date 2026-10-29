// Minimal zip reader: lists a zip File's entries and inflates them one at a
// time with the browser's own DecompressionStream, reading only the slices it
// needs, so a large archive never has to fit in memory. Supports the stored
// and deflate methods (what every common zip tool writes); not ZIP64, so
// archives over 4 GB need splitting.

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const view = async (file, start, end) => new DataView(await file.slice(start, end).arrayBuffer());

// Returns [{ path, size, blob: () => Promise<Blob> }] for every file entry.
export async function readZip(file) {
  // The end-of-central-directory record sits in the last 22 bytes, plus up to
  // 64 KB of trailing comment.
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This doesn’t look like a zip file.');
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('This zip is too large (ZIP64). Split it into smaller zips, or import the folder instead.');
  const cd = await view(file, cdOffset, cdOffset + cdSize);
  const dec = new TextDecoder();
  const out = [];
  for (let p = 0, n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('This zip file is damaged.');
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const compSize = u32(cd, p + 20);
    const size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const local = u32(cd, p + 42);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // a folder
    if (flags & 1) throw new Error('Encrypted zips aren’t supported.');
    out.push({
      path: name,
      size,
      blob: async () => {
        const lh = await view(file, local, local + 30);
        const start = local + 30 + u16(lh, 26) + u16(lh, 28);
        const raw = file.slice(start, start + compSize);
        if (method === 0) return raw;
        if (method !== 8) throw new Error(`Unsupported compression in ${name}`);
        return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      },
    });
  }
  return out;
}
