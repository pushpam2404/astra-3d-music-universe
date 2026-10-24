// Minimal in-browser zip reader. Spotify delivers the data export as a .zip; Windows doesn't
// unzip downloads the way Safari does, so imports have to read the zip itself.
// Uses the native DecompressionStream, so there's no dependency. Handles stored and deflated
// entries, which is all Spotify (and Windows' "Send to compressed folder") produces.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export const isZipFile = (file) => /\.zip$/i.test(file?.name || '');

/**
 * Returns the entries of `zipFile` whose name passes `keep(name)` as File objects
 * (named by their base name, so they look like files picked from the unzipped folder).
 */
export async function extractZipEntries(zipFile, keep = () => true) {
  // The end-of-central-directory record sits in the last 22 bytes + up to 64 KB of comment.
  const tailSize = Math.min(zipFile.size, 22 + 0xffff);
  const tail = new DataView(await zipFile.slice(zipFile.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${zipFile.name} isn’t a readable zip file.`);

  const entryCount = tail.getUint16(eocd + 10, true);
  const dirSize = tail.getUint32(eocd + 12, true);
  const dirOffset = tail.getUint32(eocd + 16, true);
  if (dirOffset === 0xffffffff || entryCount === 0xffff) {
    throw new Error(`${zipFile.name} is too large to read here. Unzip it and choose the folder instead.`);
  }

  const dir = new DataView(await zipFile.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const decoder = new TextDecoder();
  const out = [];
  let p = 0;
  for (let n = 0; n < entryCount && p + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(p, true) !== CENTRAL_SIG) break;
    const method = dir.getUint16(p + 10, true);
    const compressedSize = dir.getUint32(p + 20, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    const localOffset = dir.getUint32(p + 42, true);
    const path = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const name = path.split('/').pop();
    if (!name || path.startsWith('__MACOSX/') || name.startsWith('._') || !keep(name)) continue;
    if (method !== 0 && method !== 8) continue;

    const local = new DataView(await zipFile.slice(localOffset, localOffset + 30).arrayBuffer());
    if (local.getUint32(0, true) !== LOCAL_SIG) continue;
    const dataStart = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const data = zipFile.slice(dataStart, dataStart + compressedSize);
    const blob = method === 0
      ? data
      : await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    out.push(new File([blob], name, { type: 'application/json' }));
  }
  return out;
}
