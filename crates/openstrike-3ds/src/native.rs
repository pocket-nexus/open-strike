use crate::{
    maps::{AlignedMapBuffer, MAP_CATALOG},
    radar::Projection,
    *,
};
use crate::world::WorldDraws;
use openstrike_core::frame_times::FrameTimes;
use alloc::{string::String, vec::Vec};
use core::ffi::c_void;
use glam::{Mat4, Vec3};
use openstrike_core::{
    clock::{FixedClock, TICK_SECONDS},
    effect_geometry::EffectGeometry,
    sim::Command,
    StrikeSim,
};
use pocket3d_bsp::cooked::{self, CookedMap};
use pocket3d_gles2::Camera3d;

#[used]
static UI_LINK: extern "C" fn(u32) = pocketjs_3ds_core::ui_init;

extern "C" {
    fn osgpu_init() -> i32;
    fn osgpu_stats(out: *mut f32);
    fn osgpu_shutdown();
    fn osgpu_world(
        verts: *const u8,
        count: u32,
        indices: *const u16,
        index_count: u32,
        textures: u32,
    ) -> i32;
    fn osgpu_clear_world();
    fn osgpu_texture(index: u32, rgba: *const u8, width: u32, height: u32) -> i32;
    fn osgpu_begin(view: *const f32, sky: *const f32);
    fn osgpu_world_begin();
    fn osgpu_run(texture: u32, base: u32, first: u32, count: u32, masked: i32, blended: i32)
        -> i32;
    fn osgpu_color(
        vertices: *const present_data::ColorVertex,
        count: usize,
        model: *const f32,
        mode: i32,
    ) -> i32;
    fn JS_NewStringLen(ctx: *mut JSContext, s: *const u8, len: usize) -> JSValue;
    fn JS_NewArray(ctx: *mut JSContext) -> JSValue;
    fn JS_SetPropertyUint32(
        ctx: *mut JSContext,
        object: JSValue,
        index: u32,
        value: JSValue,
    ) -> i32;
}
struct Game {
    sim: StrikeSim,
    map: CookedMap<'static>,
    draws: WorldDraws,
    character: openstrike_character::Asset,
    mod_index: usize,
    projectile: Vec<present_data::ColorVertex>,
    next_texture: usize,
    projection: Projection,
    radar_texture: i32,
    radar_floor: f32,
    radar_job: Option<radar::RasterJob>,
    floors: radar::FloorMesh,
}
struct State {
    context: *mut JSContext,
    global: JSValue,
    game: Option<Game>, // borrowed map views must drop before buffer mutation
    buffer: AlignedMapBuffer,
    config: Vec<Command>,
    pending: Option<strike::HostCmd>,
    input: input::PadInput,
    frame: u32,
    time: f64,
    rifle: Vec<present_data::ColorVertex>,
    effects: EffectGeometry<present_data::ColorVertex>,
    clock: FixedClock,
    alpha: f32,
    now: u64,
    reload_pending: bool,
}
static mut STATE: Option<State> = None;
// Separate intent storage: QuickJS callbacks may run while State is borrowed.
static mut TOUCH_INPUT: touch::TouchInput = touch::TouchInput::new();
// Keep diagnostics outside State for the same reentrant QuickJS boundary.
static mut FRAME_TIMES: FrameTimes = FrameTimes::new();
static mut WORLD_COUNTS: [u32; 2] = [0; 2];

unsafe fn drain(s: &mut State) {
    strike::drain(|cmd| {
        if let Some(g) = &mut s.game {
            g.sim.apply(cmd, 0);
            for bot in &mut g.sim.bots {
                bot.muzzle_local = g.character.attack_origin();
            }
        } else {
            openstrike_core::sim::retain_configuration(&mut s.config, cmd);
        }
    });
    strike::drain_host(|cmd| s.pending = Some(cmd));
}
unsafe fn release_game(s: &mut State) {
    TOUCH_INPUT = touch::TouchInput::new();
    osgpu_clear_world();
    if let Some(g) = s.game.take() {
        pocketjs_3ds_core::ui_free_texture(g.radar_texture);
        drop(g);
    }
}
unsafe fn map_error(s: &mut State, error: &str) -> bool {
    release_game(s);
    s.time = 0.;
    // Remount the shared menu before delivering its retryable load error.
    strike::dispatch_menu(s.context, s.global, s.time)
        && radar_snapshot(s)
        && call(
            s,
            b"__mapError\0",
            JS_NewStringLen(s.context, error.as_ptr(), error.len()),
        )
}
unsafe fn call(s: &State, name: &'static [u8], value: JSValue) -> bool {
    let native = JS_GetPropertyStr(s.context, s.global, b"strike\0".as_ptr().cast());
    let callback = JS_GetPropertyStr(s.context, native, name.as_ptr().cast());
    let mut ok = true;
    if !JS_IsUndefined(callback) {
        let mut args = [value];
        let result = JS_Call(s.context, callback, native, 1, args.as_mut_ptr());
        ok = JS_ValueGetTag(result) != JS_TAG_EXCEPTION;
        JS_FreeValue(s.context, result);
    }
    JS_FreeValue(s.context, value);
    JS_FreeValue(s.context, callback);
    JS_FreeValue(s.context, native);
    ok
}
unsafe fn property(ctx: *mut JSContext, obj: JSValue, key: &'static [u8], value: JSValue) {
    JS_SetPropertyStr(ctx, obj, key.as_ptr().cast(), value);
}
unsafe fn number(ctx: *mut JSContext, obj: JSValue, key: &'static [u8], value: f64) {
    property(ctx, obj, key, JS_NewFloat64(ctx, value));
}
unsafe fn radar_snapshot(s: &State) -> bool {
    let ctx = s.context;
    let Some(g) = &s.game else {
        return call(s, b"__radar\0", JS_UNDEFINED);
    };
    let snapshot = JS_NewObject(ctx);
    property(
        ctx,
        snapshot,
        b"map\0",
        JS_NewStringLen(ctx, g.map.name.as_ptr(), g.map.name.len()),
    );
    number(ctx, snapshot, b"texture\0", g.radar_texture as f64);
    number(ctx, snapshot, b"floor\0", g.sim.player.state.pos.y as f64);
    let point = g.projection.point(g.sim.player.state.pos);
    number(ctx, snapshot, b"x\0", point[0] as f64);
    number(ctx, snapshot, b"y\0", point[1] as f64);
    number(ctx, snapshot, b"yaw\0", g.sim.player.yaw as f64);
    number(
        ctx,
        snapshot,
        b"loading\0",
        g.next_texture as f64 / g.map.textures.len().max(1) as f64,
    );
    let bots = JS_NewArray(ctx);
    for (i, bot) in g.sim.bots.iter().filter(|b| b.alive()).take(16).enumerate() {
        let dot = JS_NewObject(ctx);
        let p = g.projection.point(bot.state.pos);
        number(ctx, dot, b"x\0", p[0] as f64);
        number(ctx, dot, b"y\0", p[1] as f64);
        number(
            ctx,
            dot,
            b"height\0",
            (bot.state.pos.y - g.sim.player.state.pos.y) as f64,
        );
        JS_SetPropertyUint32(ctx, bots, i as u32, dot);
    }
    property(ctx, snapshot, b"bots\0", bots);
    call(s, b"__radar\0", snapshot)
}
unsafe fn load(s: &mut State, index: usize, mod_index: usize) -> Result<(), &'static str> {
    let pack = openstrike_mods::get(mod_index).ok_or("Unknown loadout")?;
    let entry = MAP_CATALOG.get(index).ok_or("Unknown map")?;
    release_game(s);
    let bytes = s.buffer.load(entry)?;
    let bytes = core::slice::from_raw_parts(bytes.as_ptr(), bytes.len());
    let map = cooked::read(bytes)?;
    let mut sim = sim_boot::from_map(&map, &s.config)?;
    pack.configure(&mut sim);
    let draws = WorldDraws::new(&map);
    let indices = draws.indices(&map);
    if osgpu_world(
        map.verts.as_ptr(),
        map.vert_count,
        indices.as_ptr(),
        indices.len() as u32,
        map.textures.len() as u32,
    ) == 0
    {
        osgpu_clear_world();
        return Err("Map exceeds available GPU memory");
    }
    let character = pack.character();
    for bot in &mut sim.bots {
        bot.muzzle_local = character.attack_origin();
    }
    load_character(character)?;
    let floor = sim.player.state.pos.y;
    let floors = radar::FloorMesh::new(&map);
    let mut radar = radar::RasterJob::new(&floors, floor);
    radar.advance(&floors, usize::MAX);
    let (projection, pixels) = (radar.projection, radar.pixels());
    let pixels = radar::texture_pixels(&pixels);
    let texture = pocketjs_3ds_core::ui_upload_texture(
        pixels.as_ptr(),
        pixels.len(),
        radar::TEXTURE_WIDTH as u32,
        radar::TEXTURE_HEIGHT as u32,
        3,
    );
    if texture < 0 {
        osgpu_clear_world();
        return Err("Minimap texture allocation failed");
    }
    s.rifle = pack
        .viewmodel()
        .map(mesh_vertices)
        .unwrap_or_else(present_data::build_rifle);
    s.game = Some(Game {
        draws,
        character,
        mod_index,
        projectile: pack
            .projectile_mesh()
            .map(mesh_vertices)
            .unwrap_or_default(),
        sim,
        map,
        next_texture: 0,
        projection,
        radar_texture: texture,
        radar_floor: floor,
        radar_job: None,
        floors,
    });
    s.input = input::PadInput::new();
    s.reload_pending = false;
    s.clock.reset(s.now);
    FRAME_TIMES = FrameTimes::new();
    Ok(())
}
unsafe extern "C" fn js_touch(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    let buttons = ffi::arg_i32(ctx, argc, argv, 0) as u32;
    let mut x = 0.;
    let mut y = 0.;
    if argc > 1 {
        JS_ToFloat64(ctx, &mut x, *argv.add(1));
    }
    if argc > 2 {
        JS_ToFloat64(ctx, &mut y, *argv.add(2));
    }
    TOUCH_INPUT.update(buttons, x as f32, y as f32);
    JS_UNDEFINED
}
#[no_mangle]
pub unsafe extern "C" fn os3ds_boot(ctx: *mut c_void) -> i32 {
    if STATE.is_some() || osgpu_init() == 0 {
        return 0;
    }
    let ctx = ctx.cast();
    let global = JS_GetGlobalObject(ctx);
    strike::drain(drop);
    strike::drain_host(drop);
    let names: Vec<String> = MAP_CATALOG.iter().map(|m| String::from(m.name)).collect();
    if !strike::register(
        ctx,
        global,
        &names,
        strike::HostConfig {
            mods: openstrike_mods::METADATA,
            initial_mod: openstrike_mods::INITIAL,
            network_supported: false,
        },
    ) {
        JS_FreeValue(ctx, global);
        osgpu_shutdown();
        return 0;
    }
    let surface = JS_GetPropertyStr(ctx, global, b"strike\0".as_ptr().cast());
    ffi::add_fn(ctx, surface, b"touchInput\0", js_touch, 3);
    ffi::add_fn(ctx, surface, b"__perf\0", js_perf, 0);
    JS_FreeValue(ctx, surface);
    STATE = Some(State {
        context: ctx,
        global,
        game: None,
        buffer: AlignedMapBuffer::default(),
        config: Vec::new(),
        pending: None,
        input: input::PadInput::new(),
        frame: 0,
        time: 0.,
        rifle: present_data::build_rifle(),
        effects: EffectGeometry::default(),
        clock: FixedClock::new(0),
        alpha: 1.,
        now: 0,
        reload_pending: false,
    });
    FRAME_TIMES = FrameTimes::new();
    WORLD_COUNTS = [0; 2];
    1
}
#[no_mangle]
pub unsafe extern "C" fn os3ds_tick(buttons: u32, left: u32, right: u32, now: u64) -> i32 {
    let Some(s) = STATE.as_mut() else {
        return 0;
    };
    s.frame += 1;
    s.now = now;
    let due = s.clock.advance(now);
    s.alpha = s.clock.alpha();
    let sample = input::map(&mut s.input, buttons, left, right, TICK_SECONDS);
    s.reload_pending |= sample.sim.reload;
    let ok = if let Some(g) = &mut s.game {
        if g.next_texture == g.map.textures.len() {
            FRAME_TIMES.record(now);
            for _ in 0..due {
                let mut tick = input::TickInput {
                    sim: sample.sim,
                    look_dx: sample.look_dx,
                    look_dy: sample.look_dy,
                    ui_buttons: buttons,
                };
                tick.sim.reload = core::mem::take(&mut s.reload_pending);
                TOUCH_INPUT.apply(&mut tick);
                g.sim.apply_look(tick.look_dx, tick.look_dy);
                g.sim.tick(&g.map.collision, TICK_SECONDS, &tick.sim);
            }
        } else {
            s.clock.reset(now);
            FRAME_TIMES.pause();
        }
        strike::dispatch(s.context, s.global, &mut g.sim)
    } else {
        s.time += due as f64 * TICK_SECONDS as f64;
        FRAME_TIMES.pause();
        s.reload_pending = false;
        strike::dispatch_menu(s.context, s.global, s.time)
    };
    drain(s);
    if !ok {
        return 0;
    }
    if s.frame % 6 == 0 {
        return radar_snapshot(s) as i32;
    }
    1
}

#[no_mangle]
pub unsafe extern "C" fn os3ds_after() -> i32 {
    if let Some(s) = STATE.as_mut() {
        drain(s);
        1
    } else {
        0
    }
}
#[no_mangle]
pub unsafe extern "C" fn os3ds_prepare() -> i32 {
    let Some(s) = STATE.as_mut() else {
        return 0;
    };
    if let Some(command) = s.pending.take() {
        match command {
            strike::HostCmd::ToMenu => {
                release_game(s);
                s.time = 0.;
            }
            strike::HostCmd::LoadMap { map, mod_index, .. } => {
                if let Err(error) = load(s, map, mod_index) {
                    return map_error(s, error) as i32;
                }
            }
        }
        if !radar_snapshot(s) {
            return 0;
        }
    }
    let Some(g) = s.game.as_mut() else {
        return 1;
    };
    if let Some(t) = g.map.textures.get(g.next_texture) {
        let Ok(rgba) = cooked::expand_level0_rgba(t) else {
            return map_error(s, "Map texture is invalid") as i32;
        };
        if osgpu_texture(g.next_texture as u32, rgba.as_ptr(), t.width, t.height) == 0 {
            return map_error(s, "Map textures exceed available GPU memory") as i32;
        }
        g.next_texture += 1;
    }
    if g.radar_job.is_none()
        && g.sim.player.state.on_ground
        && (g.sim.player.state.pos.y - g.radar_floor).abs() > 96.
    {
        g.radar_job = Some(radar::RasterJob::new(&g.floors, g.sim.player.state.pos.y));
    }
    if let Some(job) = &mut g.radar_job {
        if job.advance(&g.floors, 128) {
            let pixels = radar::texture_pixels(&job.pixels());
            let texture = pocketjs_3ds_core::ui_upload_texture(
                pixels.as_ptr(),
                pixels.len(),
                radar::TEXTURE_WIDTH as u32,
                radar::TEXTURE_HEIGHT as u32,
                3,
            );
            if texture >= 0 {
                pocketjs_3ds_core::ui_free_texture(g.radar_texture);
                g.radar_texture = texture;
                g.projection = job.projection;
                g.radar_floor = job.floor;
            }
            g.radar_job = None;
            return radar_snapshot(s) as i32;
        }
    }
    1
}
#[no_mangle]
pub unsafe extern "C" fn os3ds_render(surface: u32) -> i32 {
    if surface != 0 {
        return 1;
    }
    let Some(s) = STATE.as_mut() else {
        return 0;
    };
    let Some(g) = s.game.as_mut() else {
        return 1;
    };
    let camera = Camera3d {
        pos: g.sim.player.eye_interpolated(s.alpha),
        yaw: g.sim.player.yaw,
        pitch: g.sim.player.pitch,
        fov_y: 74f32.to_radians(),
        aspect: 400. / 240.,
        ..Camera3d::default()
    };
    let sky = g.map.sky.unwrap_or(pocket3d_bsp::types::SkyColors {
        horizon: Vec3::new(0.93, 0.79, 0.62),
        zenith: Vec3::new(0.34, 0.48, 0.66),
    });
    let color = |v: f32| {
        sky.horizon.lerp(
            sky.zenith,
            libm::powf(
                libm::sinf(camera.pitch + (v - 0.5) * camera.fov_y).max(0.),
                0.65,
            ),
        )
    };
    let lower = color(0.);
    let upper = color(1.);
    osgpu_begin(
        camera.view().to_cols_array().as_ptr(),
        [lower.x, lower.y, lower.z, upper.x, upper.y, upper.z].as_ptr(),
    );
    osgpu_world_begin();
    let frustum = camera.frustum();
    WORLD_COUNTS = [0; 2];
    if !g
        .draws
        .draw(&g.map, camera.pos, &frustum, |batch, first, count| {
            let b = g.map.batches[batch as usize];
            if b.texture as usize >= g.next_texture {
                return true;
            }
            WORLD_COUNTS[0] += 1;
            WORLD_COUNTS[1] += count / 3;
            osgpu_run(
                b.texture as u32,
                b.vert_base,
                first,
                count,
                g.map.textures[b.texture as usize].masked as i32,
                (b.kind == pocket3d_bsp::SurfaceKind::Water) as i32,
            ) != 0
        })
    {
        return 0;
    }
    for bot in &g.sim.bots {
        if !camera.frustum().intersects_aabb(
            bot.state.pos - Vec3::new(128., 164., 128.),
            bot.state.pos + Vec3::splat(128.),
        ) {
            continue;
        }
        let (clip, time) = bot.animation_sample();
        let (a, b, mix) = g.character.pose(clip, time).frame_pair();
        if osgpu_character(
            a as u32,
            b as u32,
            mix,
            bot.transform_scaled(1. / 256.).to_cols_array().as_ptr(),
        ) == 0
        {
            return 0;
        }
    }
    s.effects
        .prepare(&g.sim, camera.forward(), s.alpha, color_vertex);
    if !draw_color(&s.effects.world, Mat4::IDENTITY, 1) {
        return 0;
    }
    for shot in &g.sim.projectiles.list {
        let model = Mat4::from_translation(shot.position)
            * Mat4::from_rotation_x(shot.age * 10.)
            * Mat4::from_rotation_y(shot.age * 3.)
            * Mat4::from_scale(Vec3::splat(shot.config.radius));
        if !draw_color(&g.projectile, model, 0) {
            return 0;
        }
    }
    if g.sim.player.alive
        && !(g.sim.presentation.motion == openstrike_core::presentation::ViewMotion::Throw
            && g.sim.weapon.shot_age < 0.12)
    {
        let model = g.sim.viewmodel_transform_at(s.alpha);
        if !draw_color(&s.rifle, model, 2) || !draw_color(&s.effects.viewmodel, model, 3) {
            return 0;
        }
    }
    1
}
#[no_mangle]
pub unsafe extern "C" fn os3ds_shutdown() {
    if let Some(mut s) = STATE.take() {
        release_game(&mut s);
        JS_FreeValue(s.context, s.global);
    }
    osgpu_shutdown();
    strike::drain(drop);
    strike::drain_host(drop);
}

/// Capture diagnostics are sampled by the C host without entering QuickJS.
#[no_mangle]
pub unsafe extern "C" fn os3ds_stats(values: *mut f32) {
    let out = core::slice::from_raw_parts_mut(values, 18);
    out.fill(0.);
    if let Some(s) = STATE.as_ref() {
        out[0] = s.frame as f32;
        if let Some(g) = s.game.as_ref() {
            out[1] = 1.;
            out[2] = g.sim.player.state.pos.x;
            out[3] = g.sim.player.state.pos.y;
            out[4] = g.sim.player.state.pos.z;
            out[5] = g.sim.player.health as f32;
            out[6] = g.sim.bots.iter().filter(|b| b.alive()).count() as f32;
            out[7] = g.next_texture as f32;
            out[8] = g.map.textures.len() as f32;
            out[9] = g.radar_texture as f32;
            out[10] = g.sim.player.yaw;
            out[11] = g.sim.player.pitch;
            out[12] = g.sim.weapon.ammo as f32;
            out[13] = g.sim.weapon.reserve as f32;
            out[15] = g.mod_index as f32;
            out[16] = g.sim.projectiles.list.len() as f32;
            out[17] = g.sim.weapon.shot_age;
            out[14] = MAP_CATALOG
                .iter()
                .position(|entry| entry.name == g.map.name)
                .map(|index| index as f32)
                .unwrap_or(-1.);
        }
    }
}
#[repr(C)]
struct CharacterAttribute {
    uv: [f32; 2],
    color: u32,
}
extern "C" {
    fn oschar_load(
        attrs: *const CharacterAttribute,
        samples: *const i16,
        vertices: u32,
        frames: u32,
        indices: *const u16,
        count: u32,
        rgba: *const u8,
        width: u32,
    ) -> i32;
    fn osgpu_character(a: u32, b: u32, mix: f32, model: *const f32) -> i32;
}
unsafe fn load_character(asset: openstrike_character::Asset) -> Result<(), &'static str> {
    let n = asset.vertex_count();
    let attrs: Vec<_> = (0..n)
        .map(|i| {
            let uv = if asset.textured() {
                let v = asset.textured_vertex(0, i);
                [v.u as f32 / 32768., v.v as f32 / 32768.]
            } else {
                [0., 0.]
            };
            CharacterAttribute {
                uv,
                color: asset.baked_vertex(0, i).color,
            }
        })
        .collect();
    let mut samples = Vec::with_capacity(n * asset.baked_frame_count() * 3);
    for frame in 0..asset.baked_frame_count() {
        for i in 0..n {
            let v = asset.baked_vertex(frame, i);
            samples.extend_from_slice(&[v.x, v.y, v.z]);
        }
    }
    let indices: Vec<_> = (0..asset.index_count())
        .map(|i| asset.index(i) as u16)
        .collect();
    let white = [255u8; 8 * 8 * 4];
    let (width, texture) = asset.texture().unwrap_or((8, &white));
    if oschar_load(
        attrs.as_ptr(),
        samples.as_ptr(),
        n as u32,
        asset.baked_frame_count() as u32,
        indices.as_ptr(),
        indices.len() as u32,
        texture.as_ptr(),
        width as u32,
    ) == 0
    {
        return Err("Character exceeds available GPU memory");
    }
    Ok(())
}
fn mesh_vertices(mesh: openstrike_mods::ViewModel) -> Vec<present_data::ColorVertex> {
    (0..mesh.len())
        .map(|i| {
            let (p, color) = mesh.vertex(i);
            present_data::ColorVertex {
                x: p.x,
                y: p.y,
                z: p.z,
                color,
            }
        })
        .collect()
}
fn color_vertex(p: Vec3, c: [f32; 4]) -> present_data::ColorVertex {
    let b = c.map(|v| (v.clamp(0., 1.) * 255.) as u8);
    present_data::ColorVertex {
        x: p.x,
        y: p.y,
        z: p.z,
        color: u32::from_le_bytes(b),
    }
}
unsafe fn draw_color(vertices: &[present_data::ColorVertex], model: Mat4, mode: i32) -> bool {
    osgpu_color(
        vertices.as_ptr(),
        vertices.len(),
        model.to_cols_array().as_ptr(),
        mode,
    ) != 0
}
unsafe extern "C" fn js_perf(ctx: *mut JSContext, _: JSValue, _: i32, _: *mut JSValue) -> JSValue {
    let obj = JS_NewObject(ctx);
    for (key, value) in [
        b"frames\0".as_slice(),
        b"fps\0",
        b"p95Ms\0",
        b"p99Ms\0",
        b"maxMs\0",
        b"over20Ms\0",
    ]
    .into_iter()
    .zip(FRAME_TIMES.summary())
    {
        number(ctx, obj, key, value);
    }
    let mut gpu = [0f32; 4];
    osgpu_stats(gpu.as_mut_ptr());
    for (key, value) in [
        b"commandWords\0".as_slice(),
        b"commandCapacity\0",
        b"gpuDrawingMs\0",
        b"gpuProcessingMs\0",
    ]
    .into_iter()
    .zip(gpu)
    {
        number(ctx, obj, key, value as f64);
    }
    number(ctx, obj, b"worldDraws\0", WORLD_COUNTS[0] as f64);
    number(ctx, obj, b"worldTriangles\0", WORLD_COUNTS[1] as f64);
    obj
}
