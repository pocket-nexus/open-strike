//! Runtime reader/drawer for `.pwm` files produced by cook-weapons.ts.

use alloc::vec::Vec;
use core::ffi::c_void;

use glam::Mat4;
use openstrike_core::WeaponKind;
use pocket3d_gu::FramePool;
use psp::sys::{self, ClutPixelFormat, GuPrimitive, IoOpenFlags, IoWhence, MipmapLevel, TexturePixelFormat, VertexType};

const ROOTS: [&str; 2] = ["host0:/weapons/v_", "ms0:/PSP/GAME/OpenStrike/weapons/v_"];

#[repr(C)]
#[derive(Clone, Copy)]
pub struct TexVert { pub u: f32, pub v: f32, pub x: f32, pub y: f32, pub z: f32 }

pub struct Batch { width: u32, height: u32, palette: Vec<u32>, pixels: Vec<u8>, vertices: Vec<TexVert> }
pub struct WeaponModel { pub kind: WeaponKind, batches: Vec<Batch> }

fn u32le(data: &[u8], o: &mut usize) -> Result<u32, &'static str> {
    let b=data.get(*o..*o+4).ok_or("truncated weapon model")?; *o+=4;
    Ok(u32::from_le_bytes([b[0],b[1],b[2],b[3]]))
}
fn read_file(kind: WeaponKind) -> Result<Vec<u8>, &'static str> {
    for root in ROOTS {
        let mut path=Vec::new(); path.extend_from_slice(root.as_bytes()); path.extend_from_slice(kind.asset_stem().as_bytes()); path.extend_from_slice(b".pwm\0");
        let fd=unsafe{sys::sceIoOpen(path.as_ptr(),IoOpenFlags::RD_ONLY,0o777)};
        if fd.0 < 0 { continue; }
        let len=unsafe{sys::sceIoLseek(fd,0,IoWhence::End)};
        unsafe{sys::sceIoLseek(fd,0,IoWhence::Set)};
        if len<=0 { unsafe{sys::sceIoClose(fd)}; return Err("empty weapon model"); }
        let mut data: Vec<u8>=Vec::with_capacity(len as usize); unsafe{data.set_len(len as usize)};
        let mut off=0usize;
        while off<data.len() { let n=unsafe{sys::sceIoRead(fd,data.as_mut_ptr().add(off) as *mut c_void,(data.len()-off) as u32)}; if n<=0 {break} off+=n as usize; }
        unsafe{sys::sceIoClose(fd)}; data.truncate(off); return Ok(data);
    }
    Err("weapon model missing")
}

impl WeaponModel {
    pub fn load(kind: WeaponKind) -> Result<Self,&'static str> {
        let data=read_file(kind)?;
        if data.get(0..4)!=Some(b"PWM1") { return Err("bad weapon model magic"); }
        let mut o=4; if u32le(&data,&mut o)?!=1{return Err("unsupported weapon model")}; let count=u32le(&data,&mut o)? as usize;
        let mut batches=Vec::with_capacity(count);
        for _ in 0..count {
            let width=u32le(&data,&mut o)?;
            let height=u32le(&data,&mut o)?;
            let pixel_len=u32le(&data,&mut o)? as usize;
            let vert_count=u32le(&data,&mut o)? as usize;
            let _=u32le(&data,&mut o)?;
            let pal=data.get(o..o+1024).ok_or("truncated palette")?;o+=1024; let mut palette=Vec::with_capacity(256);
            for p in pal.chunks_exact(4){palette.push(u32::from_le_bytes([p[0],p[1],p[2],p[3]]));}
            let pixels=data.get(o..o+pixel_len).ok_or("truncated texture")?.to_vec();o+=pixel_len;o=(o+3)&!3;
            let mut vertices=Vec::with_capacity(vert_count);
            for _ in 0..vert_count { let mut f=[0f32;5]; for x in &mut f{*x=f32::from_bits(u32le(&data,&mut o)?)} vertices.push(TexVert{u:f[0],v:f[1],x:f[2],y:f[3],z:f[4]}); }
            unsafe {
                pocket3d_gu::writeback(core::slice::from_raw_parts(palette.as_ptr() as *const u8, palette.len()*4));
                pocket3d_gu::writeback(&pixels);
                pocket3d_gu::writeback(core::slice::from_raw_parts(vertices.as_ptr() as *const u8, vertices.len()*core::mem::size_of::<TexVert>()));
            }
            batches.push(Batch{width,height,palette,pixels,vertices});
        }
        Ok(Self{kind,batches})
    }

    pub unsafe fn draw(&self,pool:&mut FramePool,model:Mat4) {
        const VTYPE: VertexType=VertexType::from_bits_truncate(VertexType::TEXTURE_32BITF.bits()|VertexType::VERTEX_32BITF.bits()|VertexType::TRANSFORM_3D.bits());
        sys::sceGuSetMatrix(sys::MatrixMode::Model,&pocket3d_gu::to_psp_matrix(model));
        for b in &self.batches {
            sys::sceGuClutMode(ClutPixelFormat::Psm8888,0,0xff,0);sys::sceGuClutLoad(32,b.palette.as_ptr() as *const c_void);
            sys::sceGuTexMode(TexturePixelFormat::PsmT8,0,0,0);sys::sceGuTexImage(MipmapLevel::None,b.width as i32,b.height as i32,b.width as i32,b.pixels.as_ptr() as *const c_void);
            for chunk in b.vertices.chunks(3000) { let bytes=core::slice::from_raw_parts(chunk.as_ptr() as *const u8,core::mem::size_of_val(chunk));let v=pool.upload(bytes);sys::sceGuDrawArray(GuPrimitive::Triangles,VTYPE,chunk.len() as i32,core::ptr::null(),v as *const c_void); }
        }
        sys::sceGuSetMatrix(sys::MatrixMode::Model,&pocket3d_gu::to_psp_matrix(Mat4::IDENTITY));
    }
}
