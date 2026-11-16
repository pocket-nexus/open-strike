use crate::gl::*;
use alloc::{vec, vec::Vec};
use pocket3d_bsp::{
    cooked::{expand_level0_rgba, CookedMap},
    vis::VisSet,
};
use pocket3d_gles2::Camera3d;

pub struct World {
    pub map: CookedMap<'static>,
    vis: VisSet,
    ranges: Vec<Vec<(u32, u32)>>,
    buffers: [u32; 2],
    textures: Vec<u32>,
    pub triangles: u32,
    pub draws: u32,
}
impl World {
    pub unsafe fn new(map: CookedMap<'static>) -> Result<Self, &'static str> {
        let mut world = Self {
            ranges: vec![Vec::new(); map.batches.len()],
            vis: VisSet::new(map.faces.len()),
            map,
            buffers: [0; 2],
            textures: Vec::new(),
            triangles: 0,
            draws: 0,
        };
        world.ensure_graphics()?;
        Ok(world)
    }
    pub unsafe fn ensure_graphics(&mut self) -> Result<(), &'static str> {
        if self.buffers[0] != 0 {
            return Ok(());
        }
        let result = (|| {
            glGenBuffers(2, self.buffers.as_mut_ptr());
            glBindBuffer(0x8892, self.buffers[0]);
            glBufferData(
                0x8892,
                self.map.verts.len() as isize,
                self.map.verts.as_ptr().cast(),
                0x88e4,
            );
            glBindBuffer(0x8893, self.buffers[1]);
            glBufferData(
                0x8893,
                (self.map.indices.len() * 2) as isize,
                self.map.indices.as_ptr().cast(),
                0x88e4,
            );
            if self.buffers.contains(&0) || glGetError() != 0 {
                return Err("World buffer upload failed");
            }
            for t in &self.map.textures {
                let rgba = expand_level0_rgba(t).map_err(|_| "Map texture decode failed")?;
                self.textures
                    .push(texture(t.width as usize, t.height as usize, &rgba)?);
            }
            Ok(())
        })();
        if result.is_err() {
            self.release_graphics(true);
        }
        result
    }
    pub unsafe fn draw(&mut self, camera: &Camera3d) {
        self.triangles = 0;
        self.draws = 0;
        self.vis
            .update(&self.map.vis, self.map.collision.planes(), camera.pos);
        for range in &mut self.ranges {
            range.clear();
        }
        let ranges = &mut self.ranges;
        self.vis
            .gather_faces(&self.map.vis, &camera.frustum(), |i| {
                let run = self.map.faces[i as usize];
                if run.batch != 0xffff && run.index_count > 0 {
                    ranges[run.batch as usize].push((run.index_base, run.index_count as u32));
                }
            });
        for run in &self.map.always_runs {
            if run.batch != 0xffff && run.index_count > 0 {
                ranges[run.batch as usize].push((run.index_base, run.index_count as u32));
            }
        }
        glEnable(0x0b71);
        glDepthMask(1);
        glDepthFunc(0x0203);
        glDisable(0x0b44);
        glDisable(0x0be2);
        glActiveTexture(0x84c0);
        glClientActiveTexture(0x84c0);
        glMatrixMode(0x1702);
        glLoadIdentity();
        matrix(0x1701, camera.proj());
        matrix(0x1700, camera.view());
        glEnable(0x0de1);
        glTexEnvi(0x2300, 0x2200, 0x2100);
        glEnableClientState(0x8074);
        glEnableClientState(0x8076);
        glEnableClientState(0x8078);
        glBindBuffer(0x8892, self.buffers[0]);
        glBindBuffer(0x8893, self.buffers[1]);
        for (i, batch) in self.map.batches.iter().enumerate() {
            let ranges = &mut self.ranges[i];
            if ranges.is_empty() {
                continue;
            }
            ranges.sort_unstable();
            glBindTexture(0x0de1, self.textures[batch.texture as usize]);
            if self.map.textures[batch.texture as usize].masked {
                glEnable(0x0bc0);
                glAlphaFunc(0x0204, 0.5);
            } else {
                glDisable(0x0bc0);
            }
            let base = batch.vert_base as usize * 20;
            glTexCoordPointer(2, 0x1406, 20, base as *const _);
            glColorPointer(4, 0x1401, 20, (base + 8) as *const _);
            glVertexPointer(3, 0x1402, 20, (base + 12) as *const _);
            let mut n = 0;
            while n < ranges.len() {
                let (start, mut len) = ranges[n];
                n += 1;
                while n < ranges.len() && ranges[n].0 <= start + len {
                    len = len.max(ranges[n].0 + ranges[n].1 - start);
                    n += 1;
                }
                glDrawElements(4, len as i32, 0x1403, (start as usize * 2) as *const _);
                self.triangles += len / 3;
                self.draws += 1;
            }
        }
        glDisable(0x0bc0);
    }
    pub fn abandon(&mut self) {
        self.buffers = [0; 2];
        self.textures.clear();
    }
    pub unsafe fn release_graphics(&mut self, current: bool) {
        if current {
            if self.buffers != [0; 2] {
                glDeleteBuffers(2, self.buffers.as_ptr());
            }
            if !self.textures.is_empty() {
                glDeleteTextures(self.textures.len() as i32, self.textures.as_ptr());
            }
        }
        self.abandon();
    }
}
impl Drop for World {
    fn drop(&mut self) {
        unsafe {
            self.release_graphics(true);
        }
    }
}
