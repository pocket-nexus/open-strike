// SPDX-License-Identifier: MIT
//! A PocketJS native application: no winit loop, process-global paths or window.
#![allow(dead_code)] // The standalone adapter also consumes these shared modules.
mod args;
mod bot;
mod cooked_map;
mod game;
mod guest;
mod weapon;

use anyhow::{Context as _, Result};
use openstrike_core::sim::SimInput;
use pocket_desktop_native::{
    Application, Context, Event, FORMAT, KEY, LINEAR_FORMAT, MOTION, POINTER, POINTER_LOCK, RESET,
    RESIZE, Render, export_application,
};
use pocket3d::renderer::Renderer;
use std::collections::HashSet;

struct OpenStrikeModule {
    game: game::OpenStrike,
    guest: guest::StrikeGuest,
    renderer: Renderer,
    keys: HashSet<String>,
    fire: bool,
    reload: bool,
    accumulator: f64,
}
impl Application for OpenStrikeModule {
    fn create(c: Context<'_>) -> Result<Self> {
        let map = cooked_map::load(&c.root.join("maps/de_dust2.p3d"))?;
        let spawn = *map.ct_spawns.first().context("map has no player spawn")?;
        let mut game = game::OpenStrike::new(map, spawn.pos, spawn.yaw, 8);
        let renderer = Renderer::new(c.gpu, LINEAR_FORMAT)?;
        let model = c.root.join("assets/characters/police/officer.glb");
        anyhow::ensure!(model.is_file(), "installed character model is missing");
        game.upload_world_with_model(c.gpu, &renderer, Some(model));
        let guest = guest::StrikeGuest::boot_package(c.root, c.logical, c.density)?;
        Ok(Self {
            game,
            guest,
            renderer,
            keys: HashSet::new(),
            fire: false,
            reload: false,
            accumulator: 0.0,
        })
    }
    fn event(&mut self, e: &Event) -> Result<()> {
        match e.kind {
            KEY => {
                let key = e.key_name();
                if e.down != 0 {
                    if self.keys.insert(key.into()) {
                        match key {
                            "r" => self.reload = true,
                            "v" => self.game.sim.toggle_fly(),
                            "f3" => self.game.debug_overlay = !self.game.debug_overlay,
                            _ => {}
                        }
                    }
                } else {
                    self.keys.remove(key);
                }
            }
            POINTER if e.button == 0 => self.fire = e.down != 0,
            MOTION => self.game.apply_look(e.x, e.y),
            RESET => {
                self.keys.clear();
                self.fire = false;
                self.reload = false;
            }
            RESIZE => self.guest.resize((e.x as u32, e.y as u32))?,
            _ => {}
        }
        Ok(())
    }
    fn tick(&mut self, dt: f64) -> Result<()> {
        const STEP: f64 = 1.0 / 64.0;
        self.accumulator += dt.min(0.1);
        while self.accumulator >= STEP {
            self.accumulator -= STEP;
            let held = |key: &str| self.keys.contains(key);
            let input = SimInput {
                move_x: (u8::from(held("d")) as f32) - (u8::from(held("a")) as f32),
                move_y: (u8::from(held("w")) as f32) - (u8::from(held("s")) as f32),
                walk: held("shift"),
                jump: held("space"),
                fire: self.fire,
                reload: std::mem::take(&mut self.reload),
                ..Default::default()
            };
            self.game
                .sim
                .tick(&self.game.map.collision, STEP as f32, &input);
            self.guest.turn(&mut self.game)?;
        }
        Ok(())
    }
    fn render(&mut self, c: Render<'_>) -> Result<()> {
        let time = self.game.time;
        self.game.compose_base(
            (self.accumulator * 64.0) as f32,
            time,
            (c.pixels.0 as f32, c.pixels.1 as f32),
        );
        self.renderer.render(
            c.gpu,
            c.linear_target,
            c.pixels,
            &self.game.scene,
            &self.game.camera,
            &self.game.hud,
        );
        self.guest
            .render_overlay(c.gpu, c.encoder, c.target, FORMAT)
    }
}
export_application!(
    OpenStrikeModule,
    "dev.pocket-stack.openstrike",
    POINTER_LOCK
);
