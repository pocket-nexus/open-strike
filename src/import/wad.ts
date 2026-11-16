// WAD3 archives and the textures in them. A GoldSrc texture ("miptex") is 8-bit pixels with four mip levels and its
// own 256-colour palette; the same record is used inside a WAD and inside a map that embeds its textures.
import { fixedString, ImportError } from "./bsp.ts";

/** The first mip level of a texture, still palettised. */
export interface Texture {
  name: string;
  width: number;
  height: number;
  /** One palette index per pixel, rows top to bottom. */
  pixels: Uint8Array;
  /** 256 x RGB. */
  palette: Uint8Array;
}

/** Decodes a miptex record; null when it is not one (no pixels, or cut short). */
export function decodeMiptex(record: Uint8Array): Texture | null {
  if (record.length < 40) return null;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const width = view.getUint32(16, true), height = view.getUint32(20, true);
  const first = view.getUint32(24, true), last = view.getUint32(36, true);
  if (first === 0 || width === 0 || height === 0 || width > 4096 || height > 4096) return null;
  const size = width * height;
  if (first + size > record.length) return null;
  // The palette follows the smallest mip: a 16-bit colour count (256), then RGB triples.
  const mip3 = last > first ? last : first + size + (size >> 2) + (size >> 4);
  const paletteAt = mip3 + ((width >> 3) * (height >> 3)) + 2;
  const palette = new Uint8Array(768);
  if (paletteAt + 768 <= record.length) palette.set(record.subarray(paletteAt, paletteAt + 768));
  else if (paletteAt < record.length) palette.set(record.subarray(paletteAt));
  else for (let i = 0; i < 256; i++) palette[i * 3] = palette[i * 3 + 1] = palette[i * 3 + 2] = i;
  return { name: fixedString(record, 0, 16), width, height, pixels: record.slice(first, first + size), palette };
}

export interface Wad {
  /** The file's name, as given. */
  name: string;
  /** Lower-case texture name -> its miptex record. */
  entries: Map<string, Uint8Array>;
}

export function parseWad(bytes: Uint8Array, name: string): Wad {
  const { count, directory } = wadHeader(bytes, bytes.length, name);
  const entries = new Map<string, Uint8Array>();
  for (const [key, r] of wadDirectory(bytes.subarray(directory, directory + count * 32), count, bytes.length)) entries.set(key, bytes.subarray(r.at, r.at + r.size));
  return { name, entries };
}

/** A WAD's header (its first 12 bytes; the file is `size` bytes): how many entries its directory has, and where. */
export function wadHeader(head: Uint8Array, size: number, name: string): { count: number; directory: number } {
  if (head.length < 12 || size < 12) throw new ImportError(`${name} is ${size} bytes: not a WAD.`);
  const magic = fixedString(head, 0, 4);
  if (magic !== "WAD3") throw new ImportError(`${name} is not a GoldSrc texture archive: it starts with "${magic}", expected "WAD3".`);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const count = view.getInt32(4, true), directory = view.getInt32(8, true);
  if (count < 0 || directory < 0 || directory + count * 32 > size) throw new ImportError(`${name} is truncated: its directory (${count} entries at ${directory}) runs past the end of the file (${size} bytes).`);
  return { count, directory };
}

/**
 * A WAD's directory (`count` records of 32 bytes; the file is `size` bytes): lower-case texture name -> where its
 * miptex record is. The first of a name wins.
 */
export function wadDirectory(dir: Uint8Array, count: number, size: number): Map<string, { at: number; size: number }> {
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const out = new Map<string, { at: number; size: number }>();
  for (let i = 0; i < count && (i + 1) * 32 <= dir.length; i++) {
    const o = i * 32;
    const at = view.getInt32(o, true), diskSize = view.getInt32(o + 4, true);
    const type = dir[o + 12], compressed = dir[o + 13];
    // 0x43: a miptex. Pictures (0x42) and fonts (0x46) are not textures; compression was never used.
    if (type !== 0x43 || compressed !== 0 || at < 0 || diskSize < 40 || at + diskSize > size) continue;
    const key = fixedString(dir, o + 16, 16).toLowerCase();
    if (!out.has(key)) out.set(key, { at, size: diskSize });
  }
  return out;
}

/** The WAD files a map's worldspawn asks for ("wad" key: paths on the mapper's machine), as bare lower-case file names. */
export function wantedWads(wadKey: string | undefined): string[] {
  if (!wadKey) return [];
  const names: string[] = [];
  for (const path of wadKey.split(";")) {
    const base = path.trim().split(/[\\/]/).pop()!.toLowerCase();
    if (base && !names.includes(base)) names.push(base);
  }
  return names;
}
