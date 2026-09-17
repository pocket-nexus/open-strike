import {expect, test} from 'bun:test';
import {requestExtendedMemory} from '../scripts/psp-memory';

// A minimal PARAM.SFO with TITLE plus a DWORD. Distinct opaque payloads let
// the test catch offset mistakes that corrupt ICON0/PIC1 or DATA.PSP.
function fixture() {
  const sfo = Buffer.alloc(80);
  sfo.writeUInt32LE(0x46535000, 0); sfo.writeUInt32LE(0x101, 4);
  sfo.writeUInt32LE(52, 8); sfo.writeUInt32LE(68, 12); sfo.writeUInt32LE(2, 16);
  sfo.writeUInt16LE(0, 20); sfo.writeUInt16LE(0x404, 22); sfo.writeUInt32LE(4, 24); sfo.writeUInt32LE(4, 28);
  sfo.writeUInt16LE(7, 36); sfo.writeUInt16LE(0x204, 38); sfo.writeUInt32LE(5, 40); sfo.writeUInt32LE(8, 44); sfo.writeUInt32LE(4, 48);
  sfo.write('REGION\0TITLE\0', 52); sfo.writeUInt32LE(0x8000, 68); sfo.write('Test\0', 72);
  const sections = [sfo, Buffer.from('icon'), Buffer.alloc(0), Buffer.alloc(0), Buffer.from('background'), Buffer.alloc(0), Buffer.from([0, 255, 1, 240]), Buffer.from('psar')];
  const header = Buffer.alloc(40); header.writeUInt32LE(0x50425000); header.writeUInt32LE(0x10000, 4);
  let offset = 40;
  sections.forEach((section, i) => {header.writeUInt32LE(offset, 8 + i * 4); offset += section.length});
  return {pbp: Buffer.concat([header, ...sections]), sections};
}
test('extended-memory package preserves artwork, code, metadata, and idempotence', () => {
  const {pbp, sections} = fixture();
  const updated = requestExtendedMemory(pbp);
  for (let i = 1; i < 8; i++) {
    const start = updated.readUInt32LE(8 + i * 4), end = i === 7 ? updated.length : updated.readUInt32LE(12 + i * 4);
    expect(updated.subarray(start, end)).toEqual(sections[i]);
  }
  const sfo = updated.subarray(40, updated.readUInt32LE(12));
  const keys = sfo.readUInt32LE(8), values = sfo.readUInt32LE(12);
  const entries: Record<string, Buffer> = {};
  for (let i = 0; i < sfo.readUInt32LE(16); i++) {
    const at = 20 + i * 16, key = keys + sfo.readUInt16LE(at), value = values + sfo.readUInt32LE(at + 12);
    entries[sfo.toString('utf8', key, sfo.indexOf(0, key))] = sfo.subarray(value, value + sfo.readUInt32LE(at + 4));
  }
  expect(entries.MEMSIZE!.readUInt32LE()).toBe(1);
  expect(entries.REGION!.readUInt32LE()).toBe(0x8000);
  expect(entries.TITLE!.toString()).toBe('Test\0');
  expect(requestExtendedMemory(updated)).toEqual(updated);
});
test('invalid PBP and SFO offsets fail before writing a package', () => {
  const {pbp} = fixture();
  expect(() => requestExtendedMemory(pbp.subarray(0, 39))).toThrow();
  const invalid = Buffer.from(pbp); invalid.writeUInt32LE(pbp.length + 1, 12);
  expect(() => requestExtendedMemory(invalid)).toThrow();
  const badEntry = Buffer.from(pbp); badEntry.writeUInt32LE(0xfffffff0, 40 + 32);
  expect(() => requestExtendedMemory(badEntry)).toThrow();
});
