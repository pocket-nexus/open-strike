use crate::{
    maps::{AlignedMapBuffer, MAP_CATALOG},
    radar::Projection,
    *,
};
use alloc::{string::String, vec::Vec};
use core::ffi::c_void;
use glam::{Mat4, Vec3};
use openstrike_core::{sim::Command, StrikeSim};
use pocket3d_bsp::{
    cooked::{self, CookedMap},
    vis::VisSet,
};
use pocket3d_gles2::Camera3d;

#[used]
static UI_LINK: extern "C" fn(u32) = pocketjs_3ds_core::ui_init;

extern "C" {
    fn osgpu_init() -> i32;
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
    fn osgpu_begin(view: *const f32);
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
    vis: VisSet,
    runs: Vec<Vec<(u32, u32)>>,
    next_texture: usize,
    projection: Projection,
    radar_texture: i32,
    radar_floor: f32,
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
    officer: present_data::OfficerGeometry,
    effects: present_data::EffectGeometry,
}
static mut STATE: Option<State> = None;
// Separate intent storage: QuickJS callbacks may run while State is borrowed.
static mut TOUCH_INPUT: touch::TouchInput = touch::TouchInput::new();

unsafe fn drain(s: &mut State) {
    strike::drain(|cmd| {
        if let Some(g) = &mut s.game {
            g.sim.apply(cmd, 0);
        } else {
            s.config.push(cmd);
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
    if mod_index != 0 {
        return Err("This 3DS build supports the classic loadout");
    }
    let entry = MAP_CATALOG.get(index).ok_or("Unknown map")?;
    release_game(s);
    let bytes = s.buffer.load(entry)?;
    let bytes = core::slice::from_raw_parts(bytes.as_ptr(), bytes.len());
    let map = cooked::read(bytes)?;
    let sim = sim_boot::from_map(&map, &s.config)?;
    if osgpu_world(
        map.verts.as_ptr(),
        map.vert_count,
        map.indices.as_ptr(),
        map.indices.len() as u32,
        map.textures.len() as u32,
    ) == 0
    {
        osgpu_clear_world();
        return Err("Map exceeds available GPU memory");
    }
    let floor = sim.player.state.pos.y;
    let (projection, pixels) = radar::raster(&map, floor);
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
    let mut runs = Vec::new();
    runs.resize_with(map.batches.len(), Vec::new);
    s.game = Some(Game {
        vis: VisSet::new(map.faces.len()),
        sim,
        map,
        runs,
        next_texture: 0,
        projection,
        radar_texture: texture,
        radar_floor: floor,
    });
    s.input = input::PadInput::new();
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
    strike::register(ctx, global, &names);
    let surface = JS_GetPropertyStr(ctx, global, b"strike\0".as_ptr().cast());
    ffi::add_fn(ctx, surface, b"touchInput\0", js_touch, 3);
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
        officer: present_data::OfficerGeometry::new(),
        effects: present_data::EffectGeometry::default(),
    });
    1
}
#[no_mangle]
pub unsafe extern "C" fn os3ds_tick(buttons: u32, left: u32, right: u32) -> i32 {
    let Some(s) = STATE.as_mut() else {
        return 0;
    };
    s.frame += 1;
    s.time += 1. / 60.;
    let mut tick = input::map(&mut s.input, buttons, left, right, 1. / 60.);
    TOUCH_INPUT.apply(&mut tick);
    let ok = if let Some(g) = &mut s.game {
        // Load textures incrementally before advancing the round freeze clock.
        if g.next_texture == g.map.textures.len() {
            g.sim.apply_look(tick.look_dx, tick.look_dy);
            g.sim.tick(&g.map.collision, 1. / 60., &tick.sim);
        }
        strike::dispatch(s.context, s.global, &mut g.sim)
    } else {
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
            strike::HostCmd::LoadMap { map, mod_index } => {
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
    if (g.sim.player.state.pos.y - g.radar_floor).abs() > 96. {
        let (projection, pixels) = radar::raster(&g.map, g.sim.player.state.pos.y);
        let pixels = radar::texture_pixels(&pixels);
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
            g.projection = projection;
            g.radar_floor = g.sim.player.state.pos.y;
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
        pos: g.sim.player.eye_interpolated(1.),
        yaw: g.sim.player.yaw,
        pitch: g.sim.player.pitch,
        fov_y: 74f32.to_radians(),
        aspect: 400. / 240.,
        ..Camera3d::default()
    };
    osgpu_begin(camera.view().to_cols_array().as_ptr());
    osgpu_world_begin();
    g.vis
        .update(&g.map.vis, g.map.collision.planes(), camera.pos);
    for ranges in &mut g.runs {
        ranges.clear();
    }
    g.vis.gather_faces(&g.map.vis, &camera.frustum(), |i| {
        let r = &g.map.faces[i as usize];
        if r.batch != 0xffff && r.index_count > 0 {
            g.runs[r.batch as usize].push((r.index_base, r.index_count as u32));
        }
    });
    for r in &g.map.always_runs {
        if r.batch != 0xffff && r.index_count > 0 {
            g.runs[r.batch as usize].push((r.index_base, r.index_count as u32));
        }
    }
    for (i, ranges) in g.runs.iter_mut().enumerate() {
        let b = &g.map.batches[i];
        if b.texture as usize >= g.next_texture {
            continue;
        }
        ranges.sort_unstable();
        let mut first = 0;
        let mut count = 0;
        for &(start, n) in ranges.iter().chain(core::iter::once(&(u32::MAX, 0))) {
            if count > 0 && first + count != start {
                if osgpu_run(
                    b.texture as u32,
                    b.vert_base,
                    first,
                    count,
                    g.map.textures[b.texture as usize].masked as i32,
                    (b.kind == pocket3d_bsp::SurfaceKind::Water) as i32,
                ) == 0
                {
                    return 0;
                }
                count = 0;
            }
            if count == 0 {
                first = start;
            }
            count += n;
        }
    }
    for bot in &g.sim.bots {
        if !camera.frustum().intersects_aabb(
            bot.state.pos - Vec3::splat(48.),
            bot.state.pos + Vec3::splat(80.),
        ) {
            continue;
        }
        s.officer.pose(bot);
        if osgpu_color(
            s.officer.vertices.as_ptr(),
            s.officer.vertices.len(),
            bot.transform_scaled(1.).to_cols_array().as_ptr(),
            0,
        ) == 0
        {
            return 0;
        }
    }
    present_data::build_effects_into(&mut s.effects, &g.sim, camera.forward());
    if osgpu_color(
        s.effects.vertices.as_ptr(),
        s.effects.vertices.len(),
        Mat4::IDENTITY.to_cols_array().as_ptr(),
        1,
    ) == 0
    {
        return 0;
    }
    if g.sim.player.alive
        && osgpu_color(
            s.rifle.as_ptr(),
            s.rifle.len(),
            g.sim.viewmodel_transform_at(1.).to_cols_array().as_ptr(),
            2,
        ) == 0
    {
        return 0;
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
    let out = core::slice::from_raw_parts_mut(values, 15);
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
            out[14] = MAP_CATALOG
                .iter()
                .position(|entry| entry.name == g.map.name)
                .map(|index| index as f32)
                .unwrap_or(-1.);
        }
    }
}
