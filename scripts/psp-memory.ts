/** Set PARAM.SFO MEMSIZE=1 while preserving all artwork, payloads and metadata. */
export function requestExtendedMemory(pbp: Uint8Array): Buffer {
  const file = Buffer.from(pbp);
  if (file.length < 40 || file.readUInt32LE(0) !== 0x50425000) throw new Error('Invalid PBP header');
  const offsets = Array.from({length: 8}, (_, i) => file.readUInt32LE(8 + i * 4));
  if (offsets[0] !== 40 || offsets.some((n, i) => n > file.length || (i > 0 && n < offsets[i - 1]!))) {
    throw new Error('Invalid PBP section offsets');
  }
  const sections = offsets.map((n, i) => file.subarray(n, offsets[i + 1] ?? file.length));
  const sfo = sections[0]!;
  if (sfo.length < 20 || sfo.readUInt32LE(0) !== 0x46535000) throw new Error('Invalid SFO header');
  const keyStart = sfo.readUInt32LE(8), valueStart = sfo.readUInt32LE(12), count = sfo.readUInt32LE(16);
  if (count > 256 || keyStart < 20 + count * 16 || valueStart < keyStart || valueStart > sfo.length) {
    throw new Error('Invalid SFO tables');
  }
  type Entry = {key: string; format: number; used: number; value: Buffer};
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 20 + i * 16;
    const key = keyStart + sfo.readUInt16LE(at);
    const end = sfo.indexOf(0, key);
    const start = valueStart + sfo.readUInt32LE(at + 12), size = sfo.readUInt32LE(at + 8);
    const used = sfo.readUInt32LE(at + 4);
    if (key >= valueStart || end < key || end >= valueStart || start + size > sfo.length || used > size) {
      throw new Error('Invalid SFO entry');
    }
    entries.push({key: sfo.toString('utf8', key, end), format: sfo.readUInt16LE(at + 2), used, value: sfo.subarray(start, start + size)});
  }
  const value = Buffer.alloc(4); value.writeUInt32LE(1);
  const updated = entries.filter(e => e.key !== 'MEMSIZE');
  updated.push({key: 'MEMSIZE', format: 0x404, used: 4, value});
  updated.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const keys = updated.map(e => Buffer.from(e.key + '\0'));
  const keyOffset = 20 + updated.length * 16;
  const valueOffset = (keyOffset + keys.reduce((sum, b) => sum + b.length, 0) + 3) & ~3;
  const total = valueOffset + updated.reduce((sum, e) => sum + ((e.value.length + 3) & ~3), 0);
  const replacement = Buffer.alloc(total);
  sfo.copy(replacement, 0, 0, 8);
  replacement.writeUInt32LE(keyOffset, 8); replacement.writeUInt32LE(valueOffset, 12); replacement.writeUInt32LE(updated.length, 16);
  let keyCursor = 0, valueCursor = 0;
  updated.forEach((e, i) => {
    const at = 20 + i * 16;
    replacement.writeUInt16LE(keyCursor, at); replacement.writeUInt16LE(e.format, at + 2);
    replacement.writeUInt32LE(e.used, at + 4); replacement.writeUInt32LE(e.value.length, at + 8); replacement.writeUInt32LE(valueCursor, at + 12);
    keys[i]!.copy(replacement, keyOffset + keyCursor); e.value.copy(replacement, valueOffset + valueCursor);
    keyCursor += keys[i]!.length; valueCursor += (e.value.length + 3) & ~3;
  });
  sections[0] = replacement;
  const header = Buffer.from(file.subarray(0, 40));
  let cursor = 40;
  sections.forEach((s, i) => { header.writeUInt32LE(cursor, 8 + i * 4); cursor += s.length; });
  return Buffer.concat([header, ...sections]);
}
