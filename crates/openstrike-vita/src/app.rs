//! One game/guest lifetime. Shutdown owns the closed-scene GPU boundary.
use crate::presentation::Presentation;
use openstrike_core::{
    clock::{FixedClock, TICK_SECONDS},
    frame_times::FrameTimes,
    sim::{retain_configuration, Command},
    StrikeSim,
};
use openstrike_vita::{
    input::{PadInput, PadSample},
    map_data::{AlignedMapBuffer, MapCatalogue},
    sim_boot, strike,
};
use pocket3d_bsp::cooked;
use pocket3d_vita::{
    sky::{self, SkyParams},
    Camera3d, FramePool, WorldRenderer,
};
use pocketjs_vita::{dev_protocol::Bundle, graphics, input, switch, Runtime};
use std::sync::Arc;

struct Game {
    sim: StrikeSim,
    world: WorldRenderer<'static>,
    presentation: Presentation,
    mod_index: usize,
}
pub struct App {
    pub runtime: Runtime,
    game: Option<Game>, // Must drop before buffer storage is reused or freed.
    buffer: Box<AlignedMapBuffer>,
    catalogue: MapCatalogue,
    config: Vec<Command>,
    pending: Option<strike::HostCmd>,
    pad: PadInput,
    clock: FixedClock,
    reload_pending: bool,
    alpha: f32,
    time: f64,
    pool: FramePool,
    camera: Camera3d,
    perf: FrameTimes,
}
impl App {
    pub unsafe fn boot(active: &Option<Arc<Bundle>>, now: u64) -> Result<Self, String> {
        strike::drain(drop);
        strike::drain_host(drop);
        let catalogue = MapCatalogue::vita().map_err(|e| e.to_string())?;
        let embedded = switch::guest_bytes(0).ok_or("Embedded guest missing")?;
        let mut runtime = if let Some(bundle) = active {
            Runtime::with_owned_pak(bundle.pak.clone())?
        } else {
            Runtime::new(embedded.pak)?
        };
        let registered = strike::register(
            runtime.context(),
            runtime.global(),
            catalogue.names(),
            strike::HostConfig {
                mods: openstrike_mods::METADATA,
                initial_mod: openstrike_mods::INITIAL,
                network_supported: false,
            },
        );
        let evaluated = if registered {
            runtime.eval(
                active
                    .as_ref()
                    .map(|b| b.js.as_str())
                    .unwrap_or(embedded.js),
            )
        } else {
            Err("Cannot register strike catalogue".into())
        };
        if let Err(error) = evaluated {
            runtime.shutdown();
            strike::drain(drop);
            strike::drain_host(drop);
            return Err(error);
        }
        let mut config = Vec::new();
        strike::drain(|c| retain_configuration(&mut config, c));
        let mut result = Self {
            runtime,
            game: None,
            buffer: Box::new(AlignedMapBuffer::with_capacity(catalogue.largest_bytes())),
            catalogue,
            config,
            pending: None,
            pad: PadInput::new(),
            clock: FixedClock::new(now),
            reload_pending: false,
            alpha: 1.,
            time: 0.,
            pool: FramePool::new(),
            camera: Camera3d::default(),
            perf: FrameTimes::new(),
        };
        let autostart = env!("OPENSTRIKE_VITA_AUTOSTART");
        if !autostart.is_empty() {
            let index = result
                .catalogue
                .names()
                .iter()
                .position(|n| n == autostart)
                .ok_or_else(|| "Autostart map is missing".to_string());
            let load = index.and_then(|i| result.load(i, openstrike_mods::INITIAL, now));
            if let Err(e) = load {
                result.shutdown();
                return Err(e);
            }
        }
        Ok(result)
    }
    unsafe fn load(
        &mut self,
        index: usize,
        mod_index: usize,
        capture_now: u64,
    ) -> Result<(), String> {
        let name = self
            .catalogue
            .names()
            .get(index)
            .ok_or("Unknown map")?
            .clone();
        let pack = openstrike_mods::get(mod_index).ok_or("Unknown loadout")?;
        vita2d_sys::vita2d_wait_rendering_done();
        self.game = None;
        self.pool.reset();
        let bytes = self
            .catalogue
            .load(&name, &mut self.buffer)
            .map_err(|e| e.to_string())?;
        // Game is cleared before every write and before this owned arena drops.
        let bytes = core::slice::from_raw_parts(bytes.as_ptr(), bytes.len());
        let map = cooked::read(bytes).map_err(String::from)?;
        let mut sim = sim_boot::from_map(&map, &self.config).map_err(String::from)?;
        pack.configure(&mut sim);
        let presentation = Presentation::new(pack)?;
        for bot in &mut sim.bots {
            bot.muzzle_local = presentation.asset.attack_origin();
        }
        self.game = Some(Game {
            sim,
            world: WorldRenderer::new(map),
            presentation,
            mod_index,
        });
        self.pad = PadInput::new();
        self.reload_pending = false;
        #[cfg(feature = "capture")]
        let now = capture_now;
        #[cfg(not(feature = "capture"))]
        let now = {
            let _ = capture_now;
            vitasdk_sys::sceKernelGetProcessTimeWide()
        };
        self.clock.reset(now);
        self.perf = FrameTimes::new();
        Ok(())
    }
    pub unsafe fn frame(
        &mut self,
        sample: PadSample,
        touches: &input::TouchSnapshot,
        now: u64,
        paused: bool,
    ) -> Result<(), String> {
        let tick = self.pad.map(sample, TICK_SECONDS);
        self.reload_pending |= tick.sim.reload;
        let due = if paused {
            self.clock.reset(now);
            self.reload_pending = false;
            self.perf.pause();
            0
        } else {
            self.clock.advance(now)
        };
        self.alpha = self.clock.alpha();
        if let Some(game) = &mut self.game {
            if !paused {
                self.perf.record(now);
            }
            for _ in 0..due {
                let mut sim_input = tick.sim;
                sim_input.reload = core::mem::take(&mut self.reload_pending);
                game.sim.apply_look(tick.look_dx, tick.look_dy);
                game.sim
                    .tick(&game.world.map().collision, TICK_SECONDS, &sim_input);
            }
        } else {
            self.time += due as f64 * TICK_SECONDS as f64;
            self.perf.pause();
        }
        // Enter Runtime first so its 250 ms guest budget also covers strike's
        // callbacks after long map loads or a USB pause between frame turns.
        self.runtime.frame_with_input(
            tick.ui_buttons as i32,
            ((sample.ly as i32) << 8) | sample.lx as i32,
            touches,
        )?;
        let dispatched = if let Some(game) = &mut self.game {
            strike::dispatch(self.runtime.context(), self.runtime.global(), &mut game.sim)
        } else {
            strike::dispatch_menu(self.runtime.context(), self.runtime.global(), self.time)
        };
        if !dispatched {
            return Err("strike.__dispatch threw".into());
        }
        strike::drain(|command| {
            if let Some(game) = &mut self.game {
                game.sim.apply(command, 0);
                for bot in &mut game.sim.bots {
                    bot.muzzle_local = game.presentation.asset.attack_origin();
                }
            } else {
                retain_configuration(&mut self.config, command);
            }
        });
        strike::drain_host(|c| self.pending = Some(c));
        self.runtime.tick();
        Ok(())
    }
    /// Always closes the 3D pass; the caller presents even if submission fails.
    pub unsafe fn render(&mut self) -> Result<(), String> {
        graphics::begin_frame(0xff00_0000);
        self.pool.reset();
        self.camera = if let Some(g) = &self.game {
            Camera3d {
                pos: g.sim.player.eye_interpolated(self.alpha),
                yaw: g.sim.player.yaw,
                pitch: g.sim.player.pitch,
                fov_y: 74f32.to_radians(),
                ..Camera3d::default()
            }
        } else {
            Camera3d::default()
        };
        let sky = self
            .game
            .as_ref()
            .and_then(|g| g.world.map().sky)
            .map(|s| SkyParams {
                horizon: s.horizon,
                zenith: s.zenith,
            })
            .unwrap_or_default();
        pocket3d_vita::begin_3d(&self.camera);
        sky::draw(&mut self.pool, &self.camera, &sky);
        let result = if let Some(g) = &mut self.game {
            g.world.draw(&mut self.pool, &self.camera);
            g.presentation
                .draw(&mut self.pool, &g.sim, &self.camera, self.alpha)
        } else {
            Ok((0, 0))
        };
        pocket3d_vita::end_3d();
        if let Ok((calls, triangles)) = result {
            self.pool.last.draw_calls += calls;
            self.pool.last.triangles += triangles;
        }
        self.runtime.render_over();
        result?;
        if let Some(error) = pocket3d_vita::last_gxm_error() {
            return Err(error.into());
        }
        if self.pool.last.submission_errors > 0 || self.pool.last.dropped_triangles > 0 {
            return Err("GXM frame submission exhausted resources".into());
        }
        if let Some(g) = &self.game {
            if let Some(e) = g.world.geometry_error() {
                return Err(e.into());
            }
            if let Some(e) = g.world.last_texture_error {
                return Err(format!("Map texture upload failed: {e:?}"));
            }
        }
        Ok(())
    }
    pub unsafe fn after_present(&mut self, now: u64) -> Result<(), String> {
        match self.pending.take() {
            Some(strike::HostCmd::LoadMap {
                map,
                mod_index,
                crossplay: false,
            }) => self.load(map, mod_index, now)?,
            Some(strike::HostCmd::ToMenu) => {
                vita2d_sys::vita2d_wait_rendering_done();
                self.game = None;
                self.pool.reset();
                self.time = 0.;
                self.clock.reset(now);
            }
            Some(_) => return Err("Crossplay is unavailable on this host".into()),
            None => {}
        }
        Ok(())
    }
    pub fn status(&self) -> serde_json::Value {
        let p = self.perf.summary();
        serde_json::json!({"map":self.game.as_ref().map(|g|&g.world.map().name),"mod":self.game.as_ref().map(|g|openstrike_mods::get(g.mod_index).unwrap().id),"hp":self.game.as_ref().map(|g|g.sim.player.health),"ammo":self.game.as_ref().map(|g|g.sim.weapon.ammo),"bots":self.game.as_ref().map(|g|g.sim.bots.iter().filter(|b|b.alive()).count()),"perf":{"frames":p[0],"fps":p[1],"p95Ms":p[2],"p99Ms":p[3],"maxMs":p[4],"over20Ms":p[5]}})
    }
    #[cfg(feature = "capture")]
    pub unsafe fn capture(&mut self, index: u32) -> Result<(), String> {
        let root = "ux0:data/openstrike-vita/cap";
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        self.runtime
            .capture_golden(&format!("{root}/f{index:04}.rgba"))
            .map_err(|e| e.to_string())?;
        let (faces, tris, calls, resident, geometry, texture) = self
            .game
            .as_ref()
            .map(|g| {
                (
                    g.world.last_faces,
                    g.world.last_tris,
                    g.world.last_direct_draw_calls,
                    g.world.gpu_geometry_resident(),
                    g.world.geometry_error().unwrap_or("none"),
                    format!("{:?}", g.world.last_texture_error),
                )
            })
            .unwrap_or((0, 0, 0, false, "none", "None".into()));
        let texture = if texture == "None" {
            "none".into()
        } else {
            texture
        };
        let s = self.pool.last;
        let scene=format!("renderer=gxm\ngxm_error={}\ngeometry_resident={}\ngeometry_error={geometry}\ntexture_error={texture}\nworld_faces={faces}\nworld_tris={tris}\nworld_direct_draw_calls={calls}\nsubmitted_tris={}\ndraw_calls={}\ndropped_triangles={}\nsubmission_errors={}\neffect_tris={}\ncamera_yaw={}\ncamera_pitch={}\n",pocket3d_vita::last_gxm_error().unwrap_or("none"),u8::from(resident),s.triangles,s.draw_calls,s.dropped_triangles,s.submission_errors,s.additive_triangles,self.camera.yaw,self.camera.pitch);
        std::fs::write(format!("{root}/f{index:04}.scene"), scene).map_err(|e| e.to_string())
    }
    pub unsafe fn shutdown(mut self) {
        vita2d_sys::vita2d_wait_rendering_done();
        self.game = None;
        self.pool.reset();
        self.runtime.shutdown();
        strike::drain(drop);
        strike::drain_host(drop);
    }
}
