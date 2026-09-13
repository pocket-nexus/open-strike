// Convert GoldSrc Studio v10 viewmodels into OpenStrike's PSP weapon mesh.
// Usage: bun scripts/cook-weapons.ts /path/to/cstrike/models dist/weapons

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const source = process.argv[2];
const output = process.argv[3];
if (!source || !output) throw new Error("usage: cook-weapons.ts <models-dir> <output-dir>");
mkdirSync(output, { recursive: true });

const names = [
  "ak47", "aug", "awp", "deagle", "elite", "famas", "fiveseven", "g3sg1",
  "galil", "glock18", "m249", "m3", "m4a1", "mac10", "mp5", "p228",
  "p90", "scout", "sg550", "sg552", "tmp", "ump45", "usp", "xm1014",
];

type Matrix = number[];
type OutVertex = [number, number, number, number, number]; // u, v, x, y, z
type Batch = { width: number; height: number; pixels: Uint8Array; palette: Uint8Array; vertices: OutVertex[] };

function i32(v: DataView, o: number) { return v.getInt32(o, true); }
function i16(v: DataView, o: number) { return v.getInt16(o, true); }
function f32(v: DataView, o: number) { return v.getFloat32(o, true); }

function localMatrix(px: number, py: number, pz: number, ax: number, ay: number, az: number): Matrix {
  const sx = Math.sin(ax * .5), cx = Math.cos(ax * .5);
  const sy = Math.sin(ay * .5), cy = Math.cos(ay * .5);
  const sz = Math.sin(az * .5), cz = Math.cos(az * .5);
  const qx = sx * cy * cz - cx * sy * sz;
  const qy = cx * sy * cz + sx * cy * sz;
  const qz = cx * cy * sz - sx * sy * cz;
  const qw = cx * cy * cz + sx * sy * sz;
  const xx = qx*qx, yy=qy*qy, zz=qz*qz, xy=qx*qy, xz=qx*qz, yz=qy*qz, wx=qw*qx, wy=qw*qy, wz=qw*qz;
  return [1-2*(yy+zz),2*(xy-wz),2*(xz+wy),px, 2*(xy+wz),1-2*(xx+zz),2*(yz-wx),py, 2*(xz-wy),2*(yz+wx),1-2*(xx+yy),pz];
}
function mul(a: Matrix, b: Matrix): Matrix {
  const o = new Array(12).fill(0);
  for (let r=0;r<3;r++) for (let c=0;c<3;c++) o[r*4+c]=a[r*4]*b[c]+a[r*4+1]*b[4+c]+a[r*4+2]*b[8+c];
  for (let r=0;r<3;r++) o[r*4+3]=a[r*4]*b[3]+a[r*4+1]*b[7]+a[r*4+2]*b[11]+a[r*4+3];
  return o;
}
function point(m: Matrix, x: number, y: number, z: number): [number,number,number] {
  return [m[0]*x+m[1]*y+m[2]*z+m[3], m[4]*x+m[5]*y+m[6]*z+m[7], m[8]*x+m[9]*y+m[10]*z+m[11]];
}

function convert(path: string): Uint8Array {
  const src = readFileSync(path);
  const d = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (src.toString("ascii", 0, 4) !== "IDST" || i32(d,4) !== 10) throw new Error(`${path}: not Studio v10`);
  const numBones=i32(d,140), boneIndex=i32(d,144), numTextures=i32(d,180), textureIndex=i32(d,184);
  const numSkinRef=i32(d,192), skinIndex=i32(d,200), numBodyParts=i32(d,204), bodyPartIndex=i32(d,208);
  const bones: Matrix[]=[];
  for (let n=0;n<numBones;n++) {
    const o=boneIndex+n*112, parent=i32(d,o+32);
    const local=localMatrix(f32(d,o+64),f32(d,o+68),f32(d,o+72),f32(d,o+76),f32(d,o+80),f32(d,o+84));
    bones.push(parent < 0 ? local : mul(bones[parent],local));
  }
  const textures=[] as {width:number;height:number;pixels:Uint8Array;palette:Uint8Array}[];
  for (let n=0;n<numTextures;n++) {
    const o=textureIndex+n*80, width=i32(d,o+68), height=i32(d,o+72), data=i32(d,o+76);
    const count=width*height;
    textures.push({width,height,pixels:src.subarray(data,data+count),palette:src.subarray(data+count,data+count+768)});
  }
  const skin=[] as number[];
  for(let n=0;n<numSkinRef;n++) skin.push(d.getUint16(skinIndex+n*2,true));
  const grouped = new Map<number,OutVertex[]>();
  for(let bp=0;bp<numBodyParts;bp++) {
    const bo=bodyPartIndex+bp*76, numModels=i32(d,bo+64), modelIndex=i32(d,bo+72);
    // Viewmodels use body 0 by default; take the first model of each bodypart.
    if(numModels < 1) continue;
    const mo=modelIndex;
    const numMeshes=i32(d,mo+72), meshIndex=i32(d,mo+76), numVerts=i32(d,mo+80), boneInfo=i32(d,mo+84), vertIndex=i32(d,mo+88);
    const posed=[] as [number,number,number][];
    for(let n=0;n<numVerts;n++) {
      const vo=vertIndex+n*12, bone=src[boneInfo+n];
      posed.push(point(bones[bone],f32(d,vo),f32(d,vo+4),f32(d,vo+8)));
    }
    for(let mi=0;mi<numMeshes;mi++) {
      const me=meshIndex+mi*20, triIndex=i32(d,me+4), skinRef=i32(d,me+8);
      const texId=skin[skinRef] ?? skinRef, tex=textures[texId];
      if(!tex) throw new Error(`${path}: missing texture ${texId}`);
      const out=grouped.get(texId) ?? []; grouped.set(texId,out);
      let p=triIndex;
      while(true) {
        const command=i16(d,p); p+=2;
        if(command===0) break;
        const count=Math.abs(command), ring=[] as OutVertex[];
        for(let n=0;n<count;n++) {
          const vi=i16(d,p), s=i16(d,p+4), t=i16(d,p+6); p+=8;
          const v=posed[vi];
          // GoldSrc viewmodels use -Y forward and +Z up; OpenStrike uses
          // -Z forward and +Y up.
          ring.push([s/tex.width,t/tex.height,v[0],v[2],v[1]]);
        }
        for(let n=2;n<count;n++) {
          const tri = command>0
            ? (n&1 ? [ring[n-1],ring[n-2],ring[n]] : [ring[n-2],ring[n-1],ring[n]])
            : [ring[0],ring[n-1],ring[n]];
          out.push(...tri as OutVertex[]);
        }
      }
    }
  }
  const batches: Batch[]=[];
  for(const [texId,vertices] of grouped) batches.push({...textures[texId],vertices});
  let bytes=12;
  for(const b of batches) bytes+=20+1024+b.pixels.length+((4-b.pixels.length%4)%4)+b.vertices.length*20;
  const dst=new Uint8Array(bytes), w=new DataView(dst.buffer); let o=0;
  dst.set(new TextEncoder().encode("PWM1"),o);o+=4; w.setUint32(o,1,true);o+=4;w.setUint32(o,batches.length,true);o+=4;
  for(const b of batches) {
    w.setUint32(o,b.width,true);w.setUint32(o+4,b.height,true);w.setUint32(o+8,b.pixels.length,true);w.setUint32(o+12,b.vertices.length,true);w.setUint32(o+16,0,true);o+=20;
    // PSP CLUT uses ABGR8888.
    for(let n=0;n<256;n++){dst[o++]=b.palette[n*3];dst[o++]=b.palette[n*3+1];dst[o++]=b.palette[n*3+2];dst[o++]=255;}
    dst.set(b.pixels,o);o+=b.pixels.length; while(o&3)dst[o++]=0;
    for(const v of b.vertices) for(const x of v){w.setFloat32(o,x,true);o+=4;}
  }
  return dst;
}

let total=0;
for(const name of names) {
  const input=join(source,`v_${name}.mdl`), cooked=convert(input), target=join(output,`v_${name}.pwm`);
  writeFileSync(target,cooked); total+=cooked.length;
  console.log(`${basename(input)} -> ${basename(target)} (${cooked.length} bytes)`);
}
console.log(`cooked ${names.length} viewmodels (${total} bytes)`);
