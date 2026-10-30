// Minimal zip reader and writer. The reader lists a zip File's entries and inflates them one at a
// time with the browser's own DecompressionStream, reading only the slices it
// needs, so a large archive never has to fit in memory. Supports the stored
// and deflate methods (what every common zip tool writes); not ZIP64, so
// archives over 4 GB need splitting. The writer stores files as they are (art
// is already compressed) and is what pack files (.atlaspack) are made with.

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

// --- writing --------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ path, blob }]. Returns one Blob holding the zip; the files' own
// blobs are referenced, not copied, so it costs little memory beyond reading
// each once for its checksum. onProgress(done, total) as each is added.
export async function writeZip(files, onProgress = () => {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  // 1 January 1980 would do, but a real date reads better in zip tools.
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (let i = 0; i < files.length; i++) {
    const { path, blob } = files[i];
    const name = enc.encode(path);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const size = blob.size;
    if (offset + size > 0xfffffff0) throw new Error('This pack is too large for one file (over 4 GB).');
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // names are UTF-8
    head.setUint16(10, time, true); head.setUint16(12, date, true);
    head.setUint32(14, crc, true); head.setUint32(18, size, true); head.setUint32(22, size, true);
    head.setUint16(26, name.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, time, true); cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    parts.push(head, name, blob);
    central.push(cd, name);
    offset += 30 + name.length + size;
    onProgress(i + 1, files.length);
  }
  if (files.length >= 0xffff) throw new Error('This pack has too many images for one file (65,535 at most).');
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
