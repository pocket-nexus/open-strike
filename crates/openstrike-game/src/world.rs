//! The map: GoldSrc collision hulls (pocket3d-bsp) and the two sides' spawn points.
use anyhow::{Context, Result};
use glam::Vec3;
use pocket3d_bsp::Entity;
use pocket3d_bsp::trace::{Hull, MapCollision, TraceResult};
use std::path::Path;

/// GoldSrc units -> metres.
pub const UNIT: f32 = 0.0254;
/// Hull half heights (the hull's centre is the actor's position).
pub const STAND_HALF: f32 = 36.0;
pub const CROUCH_HALF: f32 = 18.0;
pub const HULL_RADIUS: f32 = 16.0;

#[derive(Clone, Copy, Debug)]
pub struct Spawn {
    /// Standing hull centre, on the ground.
    pub pos: Vec3,
    pub yaw: f32,
}

/// How a map's brush entities enter the game: drawn (`include`), solid (`solids`), climbed (`ladders`); each a brush
/// model index and its offset. Doors stand open and fragile things (glass, grates) are already broken: neither is
/// drawn or solid, so every doorway and window is a way through. Water is drawn and waded.
pub struct Layout {
    pub include: Vec<(usize, Vec3)>,
    pub solids: Vec<(usize, Vec3)>,
    pub ladders: Vec<(usize, Vec3)>,
}

pub fn brush_layout(ents: &[Entity], models: usize) -> Layout {
    let mut l = Layout {
        include: vec![(0, Vec3::ZERO)],
        solids: vec![],
        ladders: vec![],
    };
    for e in ents {
        let Some(mi) = e.brush_model() else { continue };
        if mi == 0 || mi >= models {
            continue;
        }
        let at = (mi, e.origin().unwrap_or(Vec3::ZERO));
        let class = e.classname();
        let zone = class.starts_with("trigger")
            || matches!(
                class,
                "func_buyzone"
                    | "func_bomb_target"
                    | "func_hostage_rescue"
                    | "func_escapezone"
                    | "func_vip_safetyzone"
                    | "env_bubbles"
            );
        let fragile = class == "func_breakable"
            && e.get("health")
                .and_then(|h| h.parse::<f32>().ok())
                .unwrap_or(1.0)
                <= 50.0;
        if class == "func_ladder" {
            l.ladders.push(at);
        } else if zone || fragile || class.starts_with("func_door") {
        } else if class == "func_illusionary" || class == "func_water" {
            l.include.push(at);
        } else {
            l.include.push(at);
            l.solids.push(at);
        }
    }
    l
}

pub struct Map {
    pub name: String,
    pub col: MapCollision,
    /// Spawn points per team (0: the counter-terrorists' side, 1: the terrorists').
    pub spawns: [Vec<Spawn>; 2],
    pub bounds: (Vec3, Vec3),
    ladders: Vec<(usize, Vec3)>,
}

impl Map {
    pub fn load(path: &Path) -> Result<Map> {
        let data = std::fs::read(path).with_context(|| format!("{}", path.display()))?;
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bsp = pocket3d_bsp::raw::parse(&data).with_context(|| format!("{}", path.display()))?;
        let ents = pocket3d_bsp::entities::parse_entities(&bsp.entities_text);
        let layout = brush_layout(&ents, bsp.models.len());
        let col = MapCollision::build(&bsp, &layout.solids);
        let bounds = bsp
            .models
            .first()
            .map(|m| (m.mins, m.maxs))
            .unwrap_or((Vec3::splat(-4096.0), Vec3::splat(4096.0)));
        let mut map = Map {
            name,
            col,
            spawns: [vec![], vec![]],
            bounds,
            ladders: layout.ladders,
        };
        for e in &ents {
            let team = match e.classname() {
                "info_player_start" => 0,
                "info_player_deathmatch" => 1,
                _ => continue,
            };
            let Some(pos) = e.origin() else { continue };
            if let Some(pos) = map.settle(pos + Vec3::Y * 4.0) {
                map.spawns[team].push(Spawn {
                    pos,
                    yaw: e.yaw().unwrap_or(0.0),
                });
            }
        }
        if map.spawns[0].is_empty() && map.spawns[1].is_empty() {
            anyhow::bail!("{}: no spawn points", map.name);
        }
        for t in 0..2 {
            if map.spawns[t].is_empty() {
                map.spawns[t] = map.spawns[1 - t].clone();
            }
        }
        Ok(map)
    }

    /// Whether `p` is inside a ladder's volume.
    pub fn on_ladder(&self, p: Vec3) -> bool {
        self.ladders.iter().any(|(m, off)| {
            self.col
                .trace_model(*m, Hull::Point, p - *off, p - *off)
                .start_solid
        })
    }

    /// A line of sight / bullet path.
    pub fn ray(&self, a: Vec3, b: Vec3) -> TraceResult {
        self.col.trace(Hull::Point, a, b)
    }

    pub fn los(&self, a: Vec3, b: Vec3) -> bool {
        let t = self.col.trace(Hull::Point, a, b);
        t.fraction >= 1.0 && !t.start_solid
    }

    pub fn hull(&self, hull: Hull, a: Vec3, b: Vec3) -> TraceResult {
        self.col.trace(hull, a, b)
    }

    /// Whether a hull centred at `p` is free.
    pub fn fits(&self, hull: Hull, p: Vec3) -> bool {
        !self.col.trace(hull, p, p).start_solid
    }

    /// The standing hull centre resting on the ground under `p` (within 256 units), if `p` is free.
    pub fn settle(&self, p: Vec3) -> Option<Vec3> {
        let t = self.col.trace(Hull::Stand, p, p - Vec3::Y * 256.0);
        (!t.start_solid && t.fraction < 1.0).then_some(t.end)
    }

    /// Whether the open sky is over `p` (nothing within 2000 units, or a sky brush).
    pub fn outdoors(&self, p: Vec3) -> bool {
        const SKY: i32 = -6;
        let t = self.col.trace(Hull::Point, p, p + Vec3::Y * 3000.0);
        t.fraction >= 1.0 || self.col.point_contents(t.end + Vec3::Y * 4.0) == SKY
    }
}
