use crate::{
    gl::*,
    present_data::{build_rifle, ColorVertex},
};
use alloc::vec::Vec;
use glam::{Mat4, Vec3};
use openstrike_character::Asset;
use openstrike_core::{effect_geometry::EffectGeometry, StrikeSim};
use openstrike_mods::{ModPack, ViewModel};
use pocket3d_gles2::Camera3d;

#[repr(C)]
#[derive(Clone, Copy)]
struct Vertex {
    uv: [f32; 2],
    color: u32,
    pos: [i16; 3],
    pad: u16,
}
const _: () = assert!(core::mem::size_of::<Vertex>() == 20);
pub struct Actors {
    pub asset: Asset,
    vertices: Vec<Vertex>,
    indices: Vec<u16>,
    texture: u32,
    rifle: Vec<ColorVertex>,
    projectile: Vec<ColorVertex>,
    effects: EffectGeometry<ColorVertex>,
    pub triangles: u32,
}
fn vertex(p: Vec3, c: [f32; 4]) -> ColorVertex {
    ColorVertex {
        color: u32::from_le_bytes(c.map(|n| (n.clamp(0., 1.) * 255.) as u8)),
        x: p.x,
        y: p.y,
        z: p.z,
    }
}
fn mesh(m: ViewModel) -> Vec<ColorVertex> {
    (0..m.len())
        .map(|i| {
            let (p, color) = m.vertex(i);
            ColorVertex {
                color,
                x: p.x,
                y: p.y,
                z: p.z,
            }
        })
        .collect()
}
impl Actors {
    pub unsafe fn new(pack: &ModPack) -> Result<Self, &'static str> {
        let asset = pack.character();
        if asset.vertex_count() > 65536 {
            return Err("Character exceeds GLES1 index limit");
        }
        let mut out = Self {
            asset,
            vertices: Vec::with_capacity(asset.vertex_count()),
            indices: (0..asset.index_count())
                .map(|i| asset.index(i) as u16)
                .collect(),
            texture: 0,
            rifle: pack.viewmodel().map(mesh).unwrap_or_else(build_rifle),
            projectile: pack.projectile_mesh().map(mesh).unwrap_or_default(),
            effects: EffectGeometry::default(),
            triangles: 0,
        };
        out.ensure_graphics()?;
        Ok(out)
    }
    pub unsafe fn ensure_graphics(&mut self) -> Result<(), &'static str> {
        if self.texture == 0 {
            if let Some((width, rgba)) = self.asset.texture() {
                self.texture = texture(width, width, rgba)?;
            }
        }
        Ok(())
    }
    pub unsafe fn draw(&mut self, sim: &StrikeSim, camera: &Camera3d, alpha: f32) {
        self.triangles = 0;
        glBindBuffer(0x8892, 0);
        glBindBuffer(0x8893, 0);
        for bot in &sim.bots {
            if !camera.frustum().intersects_aabb(
                bot.state.pos - Vec3::new(128., 164., 128.),
                bot.state.pos + Vec3::splat(128.),
            ) {
                continue;
            }
            let (clip, age) = bot.animation_sample();
            let (a, b, t) = self.asset.pose(clip, age).frame_pair();
            self.vertices.clear();
            for i in 0..self.asset.vertex_count() {
                let first = self.asset.baked_vertex(a, i);
                let second = self.asset.baked_vertex(b, i);
                let blend = |x: i16, y: i16| (x as f32 + (y as f32 - x as f32) * t) as i16;
                let uv = if self.asset.textured() {
                    let v = self.asset.textured_vertex(0, i);
                    [v.u as f32 / 32768., v.v as f32 / 32768.]
                } else {
                    [0.; 2]
                };
                self.vertices.push(Vertex {
                    uv,
                    color: first.color,
                    pos: [
                        blend(first.x, second.x),
                        blend(first.y, second.y),
                        blend(first.z, second.z),
                    ],
                    pad: 0,
                });
            }
            matrix(0x1700, camera.view() * bot.transform_scaled(1. / 256.));
            let p = self.vertices.as_ptr().cast::<u8>();
            glVertexPointer(3, 0x1402, 20, p.add(12).cast());
            glColorPointer(4, 0x1401, 20, p.add(8).cast());
            if self.texture != 0 {
                glEnable(0x0de1);
                glEnableClientState(0x8078);
                glBindTexture(0x0de1, self.texture);
                glTexCoordPointer(2, 0x1406, 20, p.cast());
            } else {
                glDisable(0x0de1);
                glDisableClientState(0x8078);
            }
            glDrawElements(
                4,
                self.indices.len() as i32,
                0x1403,
                self.indices.as_ptr().cast(),
            );
            self.triangles += self.indices.len() as u32 / 3;
        }
        self.effects.prepare(sim, camera.forward(), alpha, vertex);
        colored(&self.effects.world, Mat4::IDENTITY, camera.view(), true);
        for shot in &sim.projectiles.list {
            let model = Mat4::from_translation(shot.position)
                * Mat4::from_rotation_x(shot.age * 10.)
                * Mat4::from_rotation_y(shot.age * 3.)
                * Mat4::from_scale(Vec3::splat(shot.config.radius));
            colored(&self.projectile, model, camera.view(), false);
        }
        if sim.player.alive
            && !(sim.presentation.motion == openstrike_core::presentation::ViewMotion::Throw
                && sim.weapon.shot_age < 0.12)
        {
            glDepthMask(1);
            glClear(0x0100);
            let model = sim.viewmodel_transform_at(alpha);
            colored(&self.rifle, model, camera.view(), false);
            colored(&self.effects.viewmodel, model, camera.view(), true);
        }
        glDepthMask(1);
        glDisable(0x0bc0);
    }
    pub fn abandon(&mut self) {
        self.texture = 0;
    }
    pub unsafe fn release_graphics(&mut self, current: bool) {
        if current && self.texture != 0 {
            glDeleteTextures(1, &self.texture);
        }
        self.abandon();
    }
}
impl Drop for Actors {
    fn drop(&mut self) {
        unsafe {
            self.release_graphics(true);
        }
    }
}
