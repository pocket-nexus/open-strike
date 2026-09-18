//! GE presentation of the sim: baked officer animation, the rifle viewmodel,
//! and feathered additive effects. The desktop equivalent is scene
//! composition in crates/openstrike/src/game.rs — here the "scene" is GE
//! commands recorded straight into the open display list.

use alloc::vec::Vec;

use glam::{Mat4, Vec3};
use openstrike_core::muzzle;
use openstrike_core::weapon::{
    rifle_boxes, EffectKind, FxBeam, FxSprite, GUN_COLORS, MUZZLE_LOCAL,
};
use openstrike_core::{Bot, StrikeSim};
use pocket3d_gu::mesh::{clear_depth_for_viewmodel, draw_color_tris, ColorVert};
use pocket3d_gu::{Camera3d, FramePool};
use psp::sys::{self, BlendFactor, BlendOp, GuState, ShadingModel};

fn abgr(rgba: [u8; 4], brightness: f32) -> u32 {
    let c = |v: u8| ((v as f32 * brightness).clamp(0.0, 255.0)) as u32;
    0xff00_0000 | (c(rgba[2]) << 16) | (c(rgba[1]) << 8) | c(rgba[0])
}

fn abgr_f(color: [f32; 4]) -> u32 {
    let c = |v: f32| (v.clamp(0.0, 1.0) * 255.0) as u32;
    (c(color[3]) << 24) | (c(color[2]) << 16) | (c(color[1]) << 8) | c(color[0])
}

/// Emit a box as 12 vertex-colored triangles with cheap per-face shading
/// (top bright, bottom dark) so unlit geometry still reads as 3D.
fn add_box(out: &mut Vec<ColorVert>, min: Vec3, max: Vec3, rgba: [u8; 4]) {
    let corner = |x: f32, y: f32, z: f32| Vec3 {
        x: if x > 0.0 { max.x } else { min.x },
        y: if y > 0.0 { max.y } else { min.y },
        z: if z > 0.0 { max.z } else { min.z },
    };
    // (brightness, four corners CCW seen from outside)
    let faces: [(f32, [Vec3; 4]); 6] = [
        (
            0.85,
            [
                corner(1.0, -1.0, 1.0),
                corner(1.0, -1.0, -1.0),
                corner(1.0, 1.0, -1.0),
                corner(1.0, 1.0, 1.0),
            ],
        ),
        (
            0.7,
            [
                corner(-1.0, -1.0, -1.0),
                corner(-1.0, -1.0, 1.0),
                corner(-1.0, 1.0, 1.0),
                corner(-1.0, 1.0, -1.0),
            ],
        ),
        (
            1.0,
            [
                corner(-1.0, 1.0, 1.0),
                corner(1.0, 1.0, 1.0),
                corner(1.0, 1.0, -1.0),
                corner(-1.0, 1.0, -1.0),
            ],
        ),
        (
            0.5,
            [
                corner(-1.0, -1.0, -1.0),
                corner(1.0, -1.0, -1.0),
                corner(1.0, -1.0, 1.0),
                corner(-1.0, -1.0, 1.0),
            ],
        ),
        (
            0.9,
            [
                corner(-1.0, -1.0, 1.0),
                corner(1.0, -1.0, 1.0),
                corner(1.0, 1.0, 1.0),
                corner(-1.0, 1.0, 1.0),
            ],
        ),
        (
            0.65,
            [
                corner(1.0, -1.0, -1.0),
                corner(-1.0, -1.0, -1.0),
                corner(-1.0, 1.0, -1.0),
                corner(1.0, 1.0, -1.0),
            ],
        ),
    ];
    for (brightness, q) in faces {
        let color = abgr(rgba, brightness);
        let v = |p: Vec3| ColorVert {
            color,
            x: p.x,
            y: p.y,
            z: p.z,
        };
        out.extend_from_slice(&[v(q[0]), v(q[1]), v(q[2]), v(q[0]), v(q[2]), v(q[3])]);
    }
}

/// The rifle viewmodel as vertex-colored triangles (built once at boot).
pub fn build_rifle() -> Vec<ColorVert> {
    let mut out = Vec::new();
    for b in rifle_boxes() {
        add_box(&mut out, b.min, b.max, GUN_COLORS[b.color]);
    }
    out
}

/// Immutable adjacent pose pairs shared by every bot. Both formats use GE
/// morphing; the original color-only officer keeps its smaller cache.
enum PoseCache {
    Color(Vec<[openstrike_character::PackedVertex; 2]>),
    Textured(Vec<[openstrike_character::TexturedVertex; 2]>),
}
impl PoseCache {
    fn bytes(&self) -> usize {
        match self {
            Self::Color(v) => v.len() * 24,
            Self::Textured(v) => v.len() * 32,
        }
    }
    fn ptr(&self, vertex: usize) -> *const core::ffi::c_void {
        unsafe {
            match self {
                Self::Color(v) => v.as_ptr().add(vertex) as *const _,
                Self::Textured(v) => v.as_ptr().add(vertex) as *const _,
            }
        }
    }
}
#[repr(C, align(16))]
struct TextureBlock([u8; 16]);
struct CharacterTexture {
    width: usize,
    blocks: Vec<TextureBlock>,
}

pub struct CharacterRenderer {
    pairs: PoseCache,
    indices: Vec<u16>,
    held_indices: Vec<u16>,
    texture: Option<CharacterTexture>,
    pub visible: u32,
}
impl CharacterRenderer {
    pub fn new() -> Self {
        let frames = openstrike_character::baked_frame_count();
        let vertices = openstrike_character::vertex_count();
        let pairs = if openstrike_character::textured() {
            let mut pairs = Vec::with_capacity(frames * vertices);
            for frame in 0..frames {
                for i in 0..vertices {
                    pairs.push([
                        openstrike_character::textured_vertex(frame, i),
                        openstrike_character::textured_vertex((frame + 1).min(frames - 1), i),
                    ]);
                }
            }
            PoseCache::Textured(pairs)
        } else {
            let mut pairs = Vec::with_capacity(frames * vertices);
            for frame in 0..frames {
                for i in 0..vertices {
                    pairs.push([
                        openstrike_character::baked_vertex(frame, i),
                        openstrike_character::baked_vertex((frame + 1).min(frames - 1), i),
                    ]);
                }
            }
            PoseCache::Color(pairs)
        };
        assert!(pairs.bytes() <= openstrike_character::MAX_CACHE_BYTES);
        let texture = openstrike_character::texture().map(|(width, bytes)| CharacterTexture {
            width,
            blocks: (0..bytes.len() / 16)
                .map(|i| TextureBlock(openstrike_character::swizzled_rgba_block(bytes, width, i)))
                .collect(),
        });
        let mut indices = alloc::vec![0; openstrike_character::index_count()];
        openstrike_character::copy_indices(&mut indices);
        assert!(vertices * 2 <= u16::MAX as usize);
        let held_indices: Vec<u16> = indices.iter().map(|i| i * 2).collect();
        unsafe {
            sys::sceKernelDcacheWritebackRange(pairs.ptr(0), pairs.bytes() as u32);
            sys::sceKernelDcacheWritebackRange(
                indices.as_ptr() as *const _,
                (indices.len() * 2) as u32,
            );
            sys::sceKernelDcacheWritebackRange(
                held_indices.as_ptr() as *const _,
                (held_indices.len() * 2) as u32,
            );
            if let Some(t) = &texture {
                sys::sceKernelDcacheWritebackRange(
                    t.blocks.as_ptr() as *const _,
                    (t.blocks.len() * 16) as u32,
                );
            }
        }
        Self {
            pairs,
            indices,
            held_indices,
            texture,
            visible: 0,
        }
    }
    pub unsafe fn draw(&mut self, _pool: &mut FramePool, bots: &[Bot], cam: &Camera3d) {
        use core::ffi::c_void;
        use psp::sys::{
            GuPrimitive, MatrixMode, MipmapLevel, TextureFilter, TexturePixelFormat, VertexType,
        };
        let frustum = cam.frustum();
        self.visible = 0;
        let uv = if let Some(t) = &self.texture {
            sys::sceGuEnable(GuState::Texture2D);
            sys::sceGuTexMode(TexturePixelFormat::Psm8888, 0, 0, 1);
            sys::sceGuTexImage(
                MipmapLevel::None,
                t.width as i32,
                t.width as i32,
                t.width as i32,
                t.blocks.as_ptr() as *const c_void,
            );
            sys::sceGuTexFilter(TextureFilter::Linear, TextureFilter::Linear);
            sys::sceGuTexScale(1.0, 1.0);
            sys::sceGuTexOffset(0.0, 0.0);
            VertexType::TEXTURE_16BIT
        } else {
            sys::sceGuDisable(GuState::Texture2D);
            VertexType::empty()
        };
        sys::sceGuShadeModel(ShadingModel::Smooth);
        for bot in bots {
            if !frustum.intersects_aabb(
                bot.state.pos - Vec3::new(78.0, 42.0, 78.0),
                bot.state.pos + Vec3::new(78.0, 45.0, 78.0),
            ) {
                continue;
            }
            let (clip, time) = bot.animation_sample();
            let (a, b, mix) = openstrike_character::Pose::new(clip, time).frame_pair();
            let mix = if a == b { 0.0 } else { mix };
            let held = mix == 0.0;
            sys::sceGuMorphWeight(0, 1.0 - mix);
            sys::sceGuMorphWeight(1, mix);
            sys::sceGuSetMatrix(
                MatrixMode::Model,
                &pocket3d_gu::to_psp_matrix(bot.transform_scaled(32768.0 / 256.0)),
            );
            sys::sceGuDrawArray(
                GuPrimitive::Triangles,
                uv | VertexType::COLOR_8888
                    | VertexType::VERTEX_16BIT
                    | if held {
                        VertexType::empty()
                    } else {
                        VertexType::VERTICES2
                    }
                    | VertexType::INDEX_16BIT
                    | VertexType::TRANSFORM_3D,
                self.indices.len() as i32,
                if held {
                    self.held_indices.as_ptr()
                } else {
                    self.indices.as_ptr()
                } as *const c_void,
                self.pairs.ptr(a * openstrike_character::vertex_count()),
            );
            self.visible += 1;
        }
        sys::sceGuMorphWeight(0, 1.0);
        sys::sceGuMorphWeight(1, 0.0);
        sys::sceGuEnable(GuState::Texture2D);
        sys::sceGuTexFilter(TextureFilter::LinearMipmapNearest, TextureFilter::Linear);
        sys::sceGuSetMatrix(
            MatrixMode::Model,
            &pocket3d_gu::to_psp_matrix(Mat4::IDENTITY),
        );
    }
}

/// Retained CPU scratch; the frame pool owns each submitted GPU copy.
pub struct EffectRenderer {
    world: Vec<ColorVert>,
    viewmodel: Vec<ColorVert>,
    sprites: Vec<FxSprite>,
    beams: Vec<FxBeam>,
}

fn effect_vertex(p: Vec3, color: [f32; 4]) -> ColorVert {
    ColorVert {
        color: abgr_f(color),
        x: p.x,
        y: p.y,
        z: p.z,
    }
}

impl EffectRenderer {
    pub fn new() -> Self {
        Self {
            world: Vec::with_capacity(muzzle::MAX_VERTICES * 8),
            viewmodel: Vec::with_capacity(muzzle::MAX_VERTICES),
            sprites: Vec::with_capacity(32),
            beams: Vec::with_capacity(32),
        }
    }

    pub fn prepare(&mut self, sim: &StrikeSim, cam: &Camera3d) {
        self.world.clear();
        self.viewmodel.clear();
        self.sprites.clear();
        self.beams.clear();
        let fwd = cam.forward();
        let right = fwd.cross(Vec3::Y).normalize_or_zero();
        let up = right.cross(fwd);
        for effect in &sim.effects.list {
            if let EffectKind::MuzzleFlash { pos } = effect.kind {
                let out = if effect.viewmodel {
                    &mut self.viewmodel
                } else {
                    &mut self.world
                };
                muzzle::emit(effect.age, effect.ttl, effect.variant, |v| {
                    let p = if effect.viewmodel {
                        MUZZLE_LOCAL + v.position
                    } else {
                        pos + right * v.position.x + up * v.position.y - fwd * v.position.z
                    };
                    out.push(effect_vertex(p, v.color));
                });
            } else {
                effect.emit(&mut self.sprites, &mut self.beams);
            }
        }
        let mut quad = |a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: [f32; 4]| {
            for p in [a, b, c, a, c, d] {
                self.world.push(effect_vertex(p, color));
            }
        };
        for s in &self.sprites {
            let r = right * (s.size * 0.5);
            let u = up * (s.size * 0.5);
            quad(
                s.pos - r - u,
                s.pos + r - u,
                s.pos + r + u,
                s.pos - r + u,
                s.color,
            );
        }
        for b in &self.beams {
            let side = (b.b - b.a).cross(fwd).normalize_or_zero() * (b.width * 0.5);
            quad(b.a - side, b.b - side, b.b + side, b.a + side, b.color);
        }
    }

    pub unsafe fn draw_world(&self, pool: &mut FramePool) {
        draw_additive(pool, &self.world, Mat4::IDENTITY);
    }
}

unsafe fn draw_additive(pool: &mut FramePool, verts: &[ColorVert], model: Mat4) {
    if verts.is_empty() {
        return;
    }
    // Straight RGB + source alpha: fading is applied once by the GPU.
    sys::sceGuShadeModel(ShadingModel::Smooth);
    sys::sceGuEnable(GuState::Blend);
    sys::sceGuBlendFunc(
        BlendOp::Add,
        BlendFactor::SrcAlpha,
        BlendFactor::Fix,
        0,
        0xffffff,
    );
    sys::sceGuDepthMask(1);
    // A frame-pool allocation must fit one 64 KiB chunk, and chunks must
    // end on a triangle boundary. Keep working for dense modded firefights.
    for chunk in verts.chunks(4095) {
        draw_color_tris(pool, chunk, model);
    }
    sys::sceGuDepthMask(0);
    sys::sceGuDisable(GuState::Blend);
}

/// Rifle and attached muzzle flames share the current pose and depth pass.
pub unsafe fn draw_viewmodel(
    pool: &mut FramePool,
    rifle: &[ColorVert],
    sim: &StrikeSim,
    effects: &EffectRenderer,
) {
    if !sim.player.alive {
        return;
    }
    clear_depth_for_viewmodel();
    let model = sim.viewmodel_transform_at(1.0);
    draw_color_tris(pool, rifle, model);
    draw_additive(pool, &effects.viewmodel, model);
}
