use crate::{actors::Actors, ffi, gl::*, sim_boot, strike, world::World, *};
use alloc::{ffi::CString, format, string::String, vec::Vec};
use core::ffi::{c_char, c_void};
use openstrike_core::{
    clock::{FixedClock, TICK_SECONDS},
    frame_times::FrameTimes,
    sim::{retain_configuration, Command},
    StrikeSim,
};
use pocket3d_gles2::Camera3d;
use pocketjs_symbian_core::extension::{ExtensionV1, GraphicsExtensionV1, FLAG_DEPTH_BUFFER};

include!(concat!(env!("OUT_DIR"), "/maps.rs"));
extern "C" {
    fn openstrike_now_us() -> u64;
    fn openstrike_open_map(name: *const c_char) -> *mut c_void;
    fn openstrike_write_status(text: *const c_char, len: usize);
    fn JS_NewStringLen(context: *mut JSContext, text: *const u8, len: usize) -> JSValue;
    fn fseek(file: *mut c_void, offset: i32, origin: i32) -> i32;
    fn ftell(file: *mut c_void) -> i32;
    fn fread(out: *mut c_void, size: usize, n: usize, file: *mut c_void) -> usize;
    fn fclose(file: *mut c_void) -> i32;
}
struct Game {
    sim: StrikeSim,
    world: World,
    actors: Actors,
    pack: usize,
}
struct State {
    context: *mut JSContext,
    global: JSValue,
    game: Option<Game>,
    arena: Vec<u64>,
    config: Vec<Command>,
    clock: FixedClock,
    perf: FrameTimes,
    alpha: f32,
    time: f64,
    touch: input::TouchInput,
    paused: bool,
    frames: u32,
    gl_error: u32,
    error: &'static str,
}
static mut STATE: Option<State> = None;
#[used]
static CORE: extern "C" fn(u32) = pocketjs_symbian_core::ui_init;

unsafe extern "C" fn primary(c: *mut JSContext, _: JSValue, n: i32, a: *mut JSValue) -> JSValue {
    if let Some(s) = STATE.as_mut() {
        if !s.paused {
            s.touch.update(
                ffi::arg_i32(c, n, a, 0),
                ffi::arg_i32(c, n, a, 1),
                ffi::arg_i32(c, n, a, 2),
                ffi::arg_i32(c, n, a, 3),
                ffi::arg_i32(c, n, a, 4),
            );
        }
    }
    JS_UNDEFINED
}
unsafe extern "C" fn pause(c: *mut JSContext, _: JSValue, n: i32, a: *mut JSValue) -> JSValue {
    if let Some(s) = STATE.as_mut() {
        s.paused = ffi::arg_i32(c, n, a, 0) != 0;
        s.clear_input();
    }
    JS_UNDEFINED
}
impl State {
    fn clear_input(&mut self) {
        self.touch.clear();
    }
    unsafe fn load(&mut self, index: usize, pack: usize) -> Result<(), &'static str> {
        let name = MAP_NAMES.get(index).ok_or("Unknown map")?;
        let pack_data = openstrike_mods::get(pack).ok_or("Unknown loadout")?;
        glFinish();
        self.game = None;
        let path = CString::new(*name).map_err(|_| "Invalid map name")?;
        let file = openstrike_open_map(path.as_ptr());
        if file.is_null() {
            return Err("Map file missing");
        }
        let result = (|| {
            if fseek(file, 0, 2) != 0 {
                return Err("Map seek failed");
            }
            let len = ftell(file);
            if len <= 0 || len > 32 * 1024 * 1024 {
                return Err("Invalid map size");
            }
            if fseek(file, 0, 0) != 0 {
                return Err("Map rewind failed");
            }
            self.arena.resize((len as usize + 23) / 8, 0);
            let start = self.arena.as_mut_ptr().cast::<u8>();
            let start = start.add(start.align_offset(16));
            if fread(start.cast(), 1, len as usize, file) != len as usize {
                return Err("Map read failed");
            }
            let bytes = core::slice::from_raw_parts(start, len as usize);
            let map = pocket3d_bsp::cooked::read(bytes)?;
            let mut sim = sim_boot::from_map(&map, &self.config)?;
            pack_data.configure(&mut sim);
            let actors = Actors::new(pack_data)?;
            for bot in &mut sim.bots {
                bot.muzzle_local = actors.asset.attack_origin();
            }
            self.game = Some(Game {
                sim,
                world: World::new(map)?,
                actors,
                pack,
            });
            Ok(())
        })();
        fclose(file);
        self.clock.reset(openstrike_now_us());
        self.perf = FrameTimes::new();
        self.clear_input();
        self.paused = false;
        result
    }
    unsafe fn publish(&self) {
        let p = self.perf.summary();
        let (map, pack, hp, ammo, projectiles, pos, yaw, pitch, triangles, actors, draws) =
            if let Some(g) = &self.game {
                (
                    g.world.map.name.as_str(),
                    openstrike_mods::get(g.pack).unwrap().id,
                    g.sim.player.health,
                    g.sim.weapon.ammo,
                    g.sim.projectiles.list.len(),
                    g.sim.player.state.pos,
                    g.sim.player.yaw,
                    g.sim.player.pitch,
                    g.world.triangles,
                    g.actors.triangles,
                    g.world.draws,
                )
            } else {
                (
                    "menu",
                    "classic",
                    0,
                    0,
                    0,
                    glam::Vec3::ZERO,
                    0.,
                    0.,
                    0,
                    0,
                    0,
                )
            };
        let text=format!("{{\"frames\":{},\"map\":\"{}\",\"mod\":\"{}\",\"hp\":{},\"ammo\":{},\"projectiles\":{},\"position\":[{},{},{}],\"yaw\":{},\"pitch\":{},\"worldTriangles\":{},\"actorTriangles\":{},\"draws\":{},\"glError\":{},\"error\":\"{}\",\"paused\":{},\"input\":[{},{},{}],\"fps\":{},\"p95Ms\":{},\"p99Ms\":{},\"maxMs\":{}}}\n",self.frames,map,pack,hp,ammo,projectiles,pos.x,pos.y,pos.z,yaw,pitch,triangles,actors,draws,self.gl_error,self.error,self.paused,self.touch.held.move_x,self.touch.held.move_y,self.touch.buttons,p[1],p[2],p[3],p[4]);
        openstrike_write_status(text.as_ptr().cast(), text.len());
    }
}
unsafe extern "C" fn boot(c: *mut c_void, _: *const u8, _: usize, w: i32, h: i32) -> i32 {
    if w != 480 || h != 320 || MAP_NAMES.is_empty() {
        return 0;
    }
    let c = c.cast();
    let global = JS_GetGlobalObject(c);
    let maps: Vec<String> = MAP_NAMES.iter().map(|n| String::from(*n)).collect();
    if !strike::register(
        c,
        global,
        &maps,
        strike::HostConfig {
            mods: openstrike_mods::METADATA,
            initial_mod: openstrike_mods::INITIAL,
            network_supported: false,
        },
    ) {
        JS_FreeValue(c, global);
        return 0;
    }
    let surface = JS_GetPropertyStr(c, global, b"strike\0".as_ptr().cast());
    ffi::add_fn(c, surface, b"primaryInput\0", primary, 5);
    ffi::add_fn(c, surface, b"setPaused\0", pause, 1);
    JS_FreeValue(c, surface);
    STATE = Some(State {
        context: c,
        global,
        game: None,
        arena: Vec::new(),
        config: Vec::new(),
        clock: FixedClock::new(openstrike_now_us()),
        perf: FrameTimes::new(),
        alpha: 0.,
        time: 0.,
        touch: input::TouchInput::default(),
        paused: false,
        frames: 0,
        gl_error: 0,
        error: "",
    });
    1
}
unsafe extern "C" fn before(_: *mut c_void, _: u32, _: u32, _: u32) -> i32 {
    let Some(s) = STATE.as_mut() else {
        return 0;
    };
    let now = openstrike_now_us();
    let due = if s.paused {
        s.clock.reset(now);
        s.perf.pause();
        0
    } else {
        s.clock.advance(now)
    };
    s.alpha = s.clock.alpha();
    let ok = if let Some(g) = &mut s.game {
        if !s.paused {
            s.perf.record(now);
        }
        let look = s.touch.take_look();
        if !s.paused {
            g.sim.apply_look(look[0], look[1]);
        }
        for _ in 0..due {
            let input = s.touch.tick();
            g.sim.tick(&g.world.map.collision, TICK_SECONDS, &input);
        }
        strike::dispatch(s.context, s.global, &mut g.sim)
    } else {
        s.time += due as f64 * TICK_SECONDS as f64;
        strike::dispatch_menu(s.context, s.global, s.time)
    };
    s.frames = s.frames.wrapping_add(1);
    if s.frames % 60 == 0 {
        s.publish();
    }
    i32::from(ok)
}
unsafe extern "C" fn after(_: *mut c_void) -> i32 {
    let Some(s) = STATE.as_mut() else {
        return 0;
    };
    strike::drain(|c| {
        if let Some(g) = &mut s.game {
            g.sim.apply(c, 0);
            for bot in &mut g.sim.bots {
                bot.muzzle_local = g.actors.asset.attack_origin();
            }
        } else {
            retain_configuration(&mut s.config, c);
        }
    });
    let mut pending = None;
    strike::drain_host(|c| pending = Some(c));
    match pending {
        Some(strike::HostCmd::LoadMap {
            map,
            mod_index,
            crossplay: false,
        }) => {
            s.error = match s.load(map, mod_index) {
                Ok(()) => "",
                Err(e) => e,
            };
            if !s.error.is_empty() {
                s.game = None;
                s.time = 0.;
                if !strike::dispatch_menu(s.context, s.global, 0.) {
                    return 0;
                }
                let native = JS_GetPropertyStr(s.context, s.global, b"strike\0".as_ptr().cast());
                let callback =
                    JS_GetPropertyStr(s.context, native, b"__mapError\0".as_ptr().cast());
                let mut value = JS_NewStringLen(s.context, s.error.as_ptr(), s.error.len());
                let result = JS_Call(s.context, callback, native, 1, &mut value);
                let ok = JS_ValueGetTag(result) != JS_TAG_EXCEPTION;
                JS_FreeValue(s.context, result);
                JS_FreeValue(s.context, value);
                JS_FreeValue(s.context, callback);
                JS_FreeValue(s.context, native);
                s.publish();
                if !ok {
                    return 0;
                }
            }
        }
        Some(strike::HostCmd::ToMenu) => {
            glFinish();
            s.game = None;
            s.clear_input();
            s.paused = false;
            s.time = 0.;
            s.clock.reset(openstrike_now_us());
        }
        _ => {}
    }
    1
}
unsafe extern "C" fn render(_: i32, _: i32, w: i32, h: i32, _: i32, _: i32) -> i32 {
    let Some(s) = STATE.as_mut() else {
        return 0;
    };
    glViewport(0, 0, w, h);
    glDisable(0x0c11);
    glDepthMask(1);
    glClearColor(0.20, 0.28, 0.36, 1.);
    glClear(0x4000 | 0x0100);
    if let Some(g) = &mut s.game {
        if let Err(e) = g
            .world
            .ensure_graphics()
            .and_then(|_| g.actors.ensure_graphics())
        {
            s.error = e;
            s.publish();
            return 0;
        }
        let camera = Camera3d {
            pos: g.sim.player.eye_interpolated(s.alpha),
            yaw: g.sim.player.yaw,
            pitch: g.sim.player.pitch,
            aspect: w as f32 / h as f32,
            fov_y: 74f32.to_radians(),
            ..Camera3d::default()
        };
        g.world.draw(&camera);
        g.actors.draw(&g.sim, &camera, s.alpha);
    }
    glBindBuffer(0x8892, 0);
    glBindBuffer(0x8893, 0);
    glDisable(0x0bc0);
    glDepthMask(1);
    s.gl_error = glGetError();
    if s.gl_error != 0 {
        s.publish();
    }
    i32::from(s.gl_error == 0)
}
unsafe extern "C" fn release_graphics(current: i32) {
    if let Some(s) = STATE.as_mut() {
        if current != 0 {
            glFinish();
        }
        if let Some(g) = &mut s.game {
            g.world.release_graphics(current != 0);
            g.actors.release_graphics(current != 0);
        }
        s.clear_input();
        s.clock.reset(openstrike_now_us());
        s.perf.pause();
    }
}
unsafe extern "C" fn shutdown(current: i32) {
    if let Some(mut s) = STATE.take() {
        if current != 0 {
            glFinish();
        } else if let Some(g) = &mut s.game {
            g.world.abandon();
            g.actors.abandon();
        }
        s.game = None;
        JS_FreeValue(s.context, s.global);
    }
    strike::drain(drop);
    strike::drain_host(drop);
}
#[no_mangle]
pub extern "C" fn pocketjs_symbian_extension_v1() -> *const ExtensionV1 {
    static TABLE: GraphicsExtensionV1 = GraphicsExtensionV1 {
        base: ExtensionV1 {
            abi_version: 1,
            struct_size: core::mem::size_of::<GraphicsExtensionV1>() as u32,
            flags: FLAG_DEPTH_BUFFER,
            boot: Some(boot),
            shutdown: Some(shutdown),
            before_guest: Some(before),
            after_guest: Some(after),
            resize: None,
            render: Some(render),
        },
        release_graphics: Some(release_graphics),
    };
    &TABLE.base
}
