//! Vita submission only; animation samples, weapon geometry and effects are shared.
use glam::{Mat4, Vec3};
use openstrike_character::Asset;
use openstrike_core::{effect_geometry::EffectGeometry, StrikeSim};
use openstrike_mods::{ModPack, ViewModel};
use openstrike_vita::present_data::{build_rifle, ColorVertex};
use pocket3d_vita::{
    gxm::{self, GpuSlab},
    mesh, Camera3d, FramePool,
};
use vita2d_sys as v2d;

#[repr(C)]
#[derive(Clone, Copy)]
struct Vertex {
    uv: [f32; 2],
    color: u32,
    position: [i16; 3],
    padding: u16,
}
const _: () = assert!(core::mem::size_of::<Vertex>() == 20);

pub struct Presentation {
    pub asset: Asset,
    indices: Option<GpuSlab>,
    texture: *mut v2d::vita2d_texture,
    rifle: Vec<ColorVertex>,
    projectile: Vec<ColorVertex>,
    effects: EffectGeometry<ColorVertex>,
}
fn mesh_vertices(mesh: ViewModel) -> Vec<ColorVertex> {
    (0..mesh.len())
        .map(|i| {
            let (p, color) = mesh.vertex(i);
            ColorVertex {
                color,
                x: p.x,
                y: p.y,
                z: p.z,
            }
        })
        .collect()
}
fn vertex(p: Vec3, c: [f32; 4]) -> ColorVertex {
    ColorVertex {
        color: u32::from_le_bytes(c.map(|n| (n.clamp(0., 1.) * 255.) as u8)),
        x: p.x,
        y: p.y,
        z: p.z,
    }
}
impl Presentation {
    pub unsafe fn new(pack: &ModPack) -> Result<Self, String> {
        let asset = pack.character();
        let mut result = Self {
            asset,
            indices: None,
            texture: core::ptr::null_mut(),
            rifle: pack
                .viewmodel()
                .map(mesh_vertices)
                .unwrap_or_else(build_rifle),
            projectile: pack
                .projectile_mesh()
                .map(mesh_vertices)
                .unwrap_or_default(),
            effects: EffectGeometry::default(),
        };
        let indices = GpuSlab::alloc(asset.index_count() * 2).map_err(String::from)?;
        for i in 0..asset.index_count() {
            indices
                .as_ptr()
                .cast::<u16>()
                .add(i)
                .write(asset.index(i) as u16);
        }
        result.indices = Some(indices);
        if let Some((width, rgba)) = asset.texture() {
            result.texture = v2d::vita2d_create_empty_texture(width as u32, width as u32);
            if result.texture.is_null() {
                return Err("Character texture allocation failed".into());
            }
            let stride = v2d::vita2d_texture_get_stride(result.texture) as usize;
            let target = v2d::vita2d_texture_get_datap(result.texture).cast::<u8>();
            if target.is_null() || stride < width * 4 {
                return Err("Character texture layout is invalid".into());
            }
            for y in 0..width {
                core::ptr::copy_nonoverlapping(
                    rgba.as_ptr().add(y * width * 4),
                    target.add(y * stride),
                    width * 4,
                );
            }
            v2d::vita2d_texture_set_filters(
                result.texture,
                v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
                v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
            );
        }
        Ok(result)
    }
    /// The vita2d frame pool stays alive until the next GPU wait. Each actor
    /// gets a distinct indexed stream; no in-flight pose data is overwritten.
    pub unsafe fn draw(
        &mut self,
        pool: &mut FramePool,
        sim: &StrikeSim,
        camera: &Camera3d,
        alpha: f32,
    ) -> Result<(u32, u32), String> {
        let pipeline = gxm::pipeline().map_err(String::from)?;
        let mut calls = 0;
        for bot in &sim.bots {
            if !camera.frustum().intersects_aabb(
                bot.state.pos - Vec3::new(128., 164., 128.),
                bot.state.pos + Vec3::splat(128.),
            ) {
                continue;
            }
            let n = self.asset.vertex_count();
            let stream = v2d::vita2d_pool_memalign((n * core::mem::size_of::<Vertex>()) as u32, 16)
                .cast::<Vertex>();
            if stream.is_null() {
                return Err("Character frame pool exhausted".into());
            }
            let (clip, time) = bot.animation_sample();
            let (a, b, t) = self.asset.pose(clip, time).frame_pair();
            for i in 0..n {
                let first = self.asset.baked_vertex(a, i);
                let second = self.asset.baked_vertex(b, i);
                let blend = |x: i16, y: i16| (x as f32 + (y as f32 - x as f32) * t) as i16;
                let uv = if self.asset.textured() {
                    let v = self.asset.textured_vertex(0, i);
                    [v.u as f32 / 32768., v.v as f32 / 32768.]
                } else {
                    [0.; 2]
                };
                stream.add(i).write(Vertex {
                    uv,
                    color: first.color,
                    position: [
                        blend(first.x, second.x),
                        blend(first.y, second.y),
                        blend(first.z, second.z),
                    ],
                    padding: 0,
                });
            }
            let wvp = (camera.view_proj() * bot.transform_scaled(1. / 256.)).to_cols_array();
            gxm::set_depth(gxm::DepthMode::Opaque);
            let bound = if self.texture.is_null() {
                pipeline.bind_world_gouraud(&wvp)
            } else {
                pipeline.bind_world_textured(&wvp) && pipeline.set_texture(self.texture)
            };
            if !bound
                || !pipeline.set_stream(stream.cast())
                || !pipeline.draw_indexed(
                    self.indices.as_ref().unwrap().as_ptr().cast(),
                    self.asset.index_count() as u32,
                )
            {
                return Err("Character GXM submission failed".into());
            }
            calls += 1;
        }
        self.effects.prepare(sim, camera.forward(), alpha, vertex);
        mesh::draw_additive_tris(pool, &self.effects.world, Mat4::IDENTITY);
        for shot in &sim.projectiles.list {
            let model = Mat4::from_translation(shot.position)
                * Mat4::from_rotation_x(shot.age * 10.)
                * Mat4::from_rotation_y(shot.age * 3.)
                * Mat4::from_scale(Vec3::splat(shot.config.radius));
            mesh::draw_color_tris(pool, &self.projectile, model);
        }
        if sim.player.alive
            && !(sim.presentation.motion == openstrike_core::presentation::ViewMotion::Throw
                && sim.weapon.shot_age < 0.12)
        {
            mesh::clear_depth_for_viewmodel();
            let model = sim.viewmodel_transform_at(alpha);
            mesh::draw_color_tris(pool, &self.rifle, model);
            mesh::draw_additive_tris(pool, &self.effects.viewmodel, model);
        }
        Ok((calls, calls * self.asset.index_count() as u32 / 3))
    }
}
impl Drop for Presentation {
    fn drop(&mut self) {
        unsafe {
            if !self.texture.is_null() {
                v2d::vita2d_free_texture(self.texture);
            }
            if let Some(indices) = self.indices.take() {
                indices.free();
            }
        }
    }
}
