//! GLES1 submission. The shared UIKit host owns the context and depth surface.
#![allow(non_snake_case)]
use core::ffi::c_void;
extern "C" {
    pub fn glGenBuffers(n: i32, buffers: *mut u32);
    pub fn glDeleteBuffers(n: i32, buffers: *const u32);
    pub fn glBindBuffer(target: u32, buffer: u32);
    pub fn glBufferData(target: u32, size: isize, data: *const c_void, usage: u32);
    pub fn glGenTextures(n: i32, textures: *mut u32);
    pub fn glDeleteTextures(n: i32, textures: *const u32);
    pub fn glBindTexture(target: u32, texture: u32);
    pub fn glTexImage2D(
        target: u32,
        level: i32,
        format: i32,
        width: i32,
        height: i32,
        border: i32,
        format2: u32,
        kind: u32,
        data: *const c_void,
    );
    pub fn glTexParameteri(target: u32, pname: u32, value: i32);
    pub fn glTexEnvi(target: u32, pname: u32, value: i32);
    pub fn glActiveTexture(texture: u32);
    pub fn glClientActiveTexture(texture: u32);
    pub fn glEnable(cap: u32);
    pub fn glDisable(cap: u32);
    pub fn glEnableClientState(cap: u32);
    pub fn glDisableClientState(cap: u32);
    pub fn glVertexPointer(size: i32, kind: u32, stride: i32, data: *const c_void);
    pub fn glColorPointer(size: i32, kind: u32, stride: i32, data: *const c_void);
    pub fn glTexCoordPointer(size: i32, kind: u32, stride: i32, data: *const c_void);
    pub fn glDrawElements(mode: u32, count: i32, kind: u32, indices: *const c_void);
    pub fn glDrawArrays(mode: u32, first: i32, count: i32);
    pub fn glClearColor(r: f32, g: f32, b: f32, a: f32);
    pub fn glClear(mask: u32);
    pub fn glViewport(x: i32, y: i32, width: i32, height: i32);
    pub fn glMatrixMode(mode: u32);
    pub fn glLoadMatrixf(matrix: *const f32);
    pub fn glLoadIdentity();
    pub fn glDepthMask(flag: u8);
    pub fn glDepthFunc(func: u32);
    pub fn glBlendFunc(source: u32, dest: u32);
    pub fn glAlphaFunc(func: u32, value: f32);
    pub fn glGetError() -> u32;
    pub fn glFinish();
}
pub unsafe fn matrix(mode: u32, m: glam::Mat4) {
    glMatrixMode(mode);
    glLoadMatrixf(m.to_cols_array().as_ptr());
}
pub unsafe fn texture(width: usize, height: usize, rgba: &[u8]) -> Result<u32, &'static str> {
    if rgba.len() != width * height * 4 {
        return Err("Invalid texture size");
    }
    let mut id = 0;
    glGenTextures(1, &mut id);
    glBindTexture(0x0de1, id);
    for (p, v) in [
        (0x2801, 0x2601),
        (0x2800, 0x2601),
        (0x2802, 0x2901),
        (0x2803, 0x2901),
    ] {
        glTexParameteri(0x0de1, p, v);
    }
    glTexImage2D(
        0x0de1,
        0,
        0x1908,
        width as i32,
        height as i32,
        0,
        0x1908,
        0x1401,
        rgba.as_ptr().cast(),
    );
    if id == 0 || glGetError() != 0 {
        if id != 0 {
            glDeleteTextures(1, &id);
        }
        return Err("Texture upload failed");
    }
    Ok(id)
}
pub unsafe fn colored(
    vertices: &[crate::present_data::ColorVertex],
    model: glam::Mat4,
    view: glam::Mat4,
    additive: bool,
) {
    if vertices.is_empty() {
        return;
    }
    glBindBuffer(0x8892, 0);
    glBindBuffer(0x8893, 0);
    glDisable(0x0de1);
    glDisable(0x0bc0);
    glDisableClientState(0x8078);
    if additive {
        glEnable(0x0be2);
        glBlendFunc(0x0302, 1);
        glDepthMask(0);
    } else {
        glDisable(0x0be2);
        glDepthMask(1);
    }
    matrix(0x1700, view * model);
    let p = vertices.as_ptr().cast::<u8>();
    glEnableClientState(0x8074);
    glEnableClientState(0x8076);
    glVertexPointer(3, 0x1406, 16, p.add(4).cast());
    glColorPointer(4, 0x1401, 16, p.cast());
    glDrawArrays(4, 0, vertices.len() as i32);
}
