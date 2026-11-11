//! Hull-based collision tracing — a port of Quake/GoldSrc
//! `SV_RecursiveHullCheck` over clipnode trees, in Y-up space.
//!
//! Hull 0 (point) is synthesized from the render BSP nodes; hulls 1-3 come
//! from the pre-expanded clipnode lumps, so box collision against them is a
//! point trace. Sizes (Y-up, half-extents around the hull center):
//! - Stand  (hull 1): 16 x 36 x 16
//! - Large  (hull 2): 32 x 32 x 32
//! - Crouch (hull 3): 16 x 18 x 16

use alloc::vec::Vec;

use glam::Vec3;

use crate::types::{CONTENTS_EMPTY, CONTENTS_SOLID, ClipNode, Plane};

pub const DIST_EPSILON: f32 = 0.03125;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hull {
    Point,
    Stand,
    Large,
    Crouch,
}

impl Hull {
    pub fn index(self) -> usize {
        match self {
            Hull::Point => 0,
            Hull::Stand => 1,
            Hull::Large => 2,
            Hull::Crouch => 3,
        }
    }

    /// Half-extents of the hull box in Y-up space (Point is zero).
    pub fn half_extents(self) -> Vec3 {
        match self {
            Hull::Point => Vec3::ZERO,
            Hull::Stand => Vec3::new(16.0, 36.0, 16.0),
            Hull::Large => Vec3::new(32.0, 32.0, 32.0),
            Hull::Crouch => Vec3::new(16.0, 18.0, 16.0),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TraceResult {
    /// 0..1 along start->end.
    pub fraction: f32,
    pub end: Vec3,
    /// Surface normal at the impact (zero if no hit).
    pub normal: Vec3,
    pub start_solid: bool,
    pub all_solid: bool,
}

impl TraceResult {
    fn no_hit(end: Vec3) -> Self {
        Self {
            fraction: 1.0,
            end,
            normal: Vec3::ZERO,
            start_solid: false,
            all_solid: true,
        }
    }

    pub fn hit(&self) -> bool {
        self.fraction < 1.0 || self.start_solid
    }
}

/// One brush model's hull entry points.
#[derive(Clone, Copy, Debug)]
pub struct ModelHulls {
    pub headnodes: [i32; 4],
    pub origin: Vec3,
}

pub struct MapCollision {
    planes: Vec<Plane>,
    /// Hull 0, synthesized from the render nodes (children < 0 are contents).
    hull0: Vec<ClipNode>,
    clipnodes: Vec<ClipNode>,
    models: Vec<ModelHulls>,
    /// Solid brush entities to clip against in addition to the world:
    /// (model index, world offset).
    solids: Vec<(usize, Vec3)>,
    // Conservative bounds of each model/hull's solid leaves. None preserves
    // the exact traversal for unbounded or unusually complex hulls.
    model_bounds: Vec<[Option<HullBounds>; 4]>,
}

#[derive(Clone, Copy, Debug)]
struct HullBounds {
    mins: Vec3,
    maxs: Vec3,
}

impl HullBounds {
    fn intersects_segment(self, start: Vec3, end: Vec3) -> bool {
        let epsilon = Vec3::splat(DIST_EPSILON);
        (start.min(end).cmple(self.maxs + epsilon)).all()
            && (start.max(end).cmpge(self.mins - epsilon)).all()
    }
}

// Axis planes bound the union of solid cells. Oblique planes leave the box
// unchanged, so this can overestimate geometry but cannot cut it away.
fn solid_bounds(nodes: &[ClipNode], planes: &[Plane], head: i32) -> Option<HullBounds> {
    let infinite = HullBounds {
        mins: Vec3::splat(f32::NEG_INFINITY),
        maxs: Vec3::splat(f32::INFINITY),
    };
    let mut pending = alloc::vec![(head, infinite)];
    let mut result = HullBounds {
        mins: Vec3::splat(f32::INFINITY),
        maxs: Vec3::splat(f32::NEG_INFINITY),
    };
    let mut visited = 0;
    while let Some((node, bounds)) = pending.pop() {
        visited += 1;
        if visited > 4096 {
            return None;
        }
        if node < 0 {
            if node == CONTENTS_SOLID {
                result.mins = result.mins.min(bounds.mins);
                result.maxs = result.maxs.max(bounds.maxs);
            }
            continue;
        }
        let node = nodes.get(node as usize)?;
        let plane = planes.get(node.plane as usize)?;
        let axis = (0..3).find(|&axis| {
            plane.normal[axis].abs() == 1.0
                && (0..3).all(|other| other == axis || plane.normal[other] == 0.0)
        });
        for side in 0..2 {
            let mut child_bounds = bounds;
            if let Some(axis) = axis {
                let at = plane.dist / plane.normal[axis];
                if (side == 0) == (plane.normal[axis] > 0.0) {
                    child_bounds.mins[axis] = child_bounds.mins[axis].max(at);
                } else {
                    child_bounds.maxs[axis] = child_bounds.maxs[axis].min(at);
                }
            }
            if child_bounds.mins.cmple(child_bounds.maxs).all() {
                pending.push((node.children[side], child_bounds));
            }
        }
    }
    if result.mins.is_finite() && result.maxs.is_finite() {
        Some(result)
    } else {
        None
    }
}

impl MapCollision {
    #[cfg(feature = "std")]
    pub fn build(bsp: &crate::raw::RawBsp, solid_entities: &[(usize, Vec3)]) -> Self {
        let hull0 = make_hull0(&bsp.nodes, &bsp.leaves);
        let models = bsp
            .models
            .iter()
            .map(|m| ModelHulls {
                headnodes: m.headnodes,
                origin: m.origin,
            })
            .collect();
        Self::from_parts(
            bsp.planes.clone(),
            hull0,
            bsp.clipnodes.clone(),
            models,
            solid_entities.to_vec(),
        )
    }

    /// Assemble collision from pre-built parts (the cooked-map path).
    pub fn from_parts(
        planes: Vec<Plane>,
        hull0: Vec<ClipNode>,
        clipnodes: Vec<ClipNode>,
        models: Vec<ModelHulls>,
        solids: Vec<(usize, Vec3)>,
    ) -> Self {
        let mut collision = Self {
            planes,
            hull0,
            clipnodes,
            models,
            solids,
            model_bounds: Vec::new(),
        };
        collision
            .model_bounds
            .resize(collision.models.len(), [None; 4]);
        // The world is not a bounded brush; avoid traversing its tree here.
        for model in 1..collision.models.len() {
            for hull in [Hull::Point, Hull::Stand, Hull::Crouch, Hull::Large] {
                if let Some((nodes, head)) = collision.tree(hull, model) {
                    collision.model_bounds[model][hull.index()] =
                        solid_bounds(nodes, &collision.planes, head);
                }
            }
        }
        collision
    }

    pub fn planes(&self) -> &[Plane] {
        &self.planes
    }

    fn tree(&self, hull: Hull, model: usize) -> Option<(&[ClipNode], i32)> {
        let m = self.models.get(model)?;
        let head = m.headnodes[hull.index()];
        match hull {
            Hull::Point => Some((&self.hull0, head)),
            _ => Some((&self.clipnodes, head)),
        }
    }

    /// Trace against a single brush model.
    pub fn trace_model(&self, model: usize, hull: Hull, start: Vec3, end: Vec3) -> TraceResult {
        let Some((nodes, head)) = self.tree(hull, model) else {
            return TraceResult {
                all_solid: false,
                ..TraceResult::no_hit(end)
            };
        };
        let offset = self.models[model].origin;
        let (s, e) = (start - offset, end - offset);
        let mut tr = TraceResult::no_hit(e);
        let ht = HullTree {
            nodes,
            planes: &self.planes,
            first: head,
        };
        ht.check(head, 0.0, 1.0, s, e, &mut tr);
        if tr.start_solid || tr.all_solid {
            tr.start_solid = true;
            tr.fraction = 0.0;
            tr.end = start;
        } else {
            tr.end = start + (end - start) * tr.fraction;
        }
        tr
    }

    /// Trace against the world plus all registered solid brush entities.
    pub fn trace(&self, hull: Hull, start: Vec3, end: Vec3) -> TraceResult {
        let mut best = self.trace_model(0, hull, start, end);
        for &(model, entity_offset) in &self.solids {
            if model >= self.models.len() {
                continue;
            }
            if let Some(bounds) = self.model_bounds[model][hull.index()] {
                let offset = self.models[model].origin + entity_offset;
                if !bounds.intersects_segment(start - offset, end - offset) {
                    continue;
                }
            }
            let t = self.trace_model_offset(model, entity_offset, hull, start, end);
            if t.fraction < best.fraction || (t.start_solid && !best.start_solid) {
                best = t;
            }
        }
        best
    }

    fn trace_model_offset(
        &self,
        model: usize,
        entity_offset: Vec3,
        hull: Hull,
        start: Vec3,
        end: Vec3,
    ) -> TraceResult {
        let mut t = self.trace_model(model, hull, start - entity_offset, end - entity_offset);
        t.end += entity_offset;
        t
    }

    /// Contents at a point (uses hull 0 of the world).
    pub fn point_contents(&self, p: Vec3) -> i32 {
        let Some((nodes, head)) = self.tree(Hull::Point, 0) else {
            return CONTENTS_EMPTY;
        };
        let ht = HullTree {
            nodes,
            planes: &self.planes,
            first: head,
        };
        ht.contents(head, p)
    }

    /// Contents for an arbitrary hull at a point (e.g. Stand for ground checks).
    pub fn hull_contents(&self, hull: Hull, p: Vec3) -> i32 {
        let Some((nodes, head)) = self.tree(hull, 0) else {
            return CONTENTS_EMPTY;
        };
        let ht = HullTree {
            nodes,
            planes: &self.planes,
            first: head,
        };
        ht.contents(head, p)
    }
}

/// MakeHull0: mirror the render nodes into a clipnode tree; leaf children
/// become their CONTENTS_* value. `leaf_contents` maps a leaf index to its
/// contents (out-of-range leaves are treated as solid).
pub fn make_hull0(nodes: &[crate::types::Node], leaves: &[crate::types::Leaf]) -> Vec<ClipNode> {
    make_hull0_with(nodes, |i| {
        leaves.get(i).map(|l| l.contents).unwrap_or(CONTENTS_SOLID)
    })
}

pub fn make_hull0_with(
    nodes: &[crate::types::Node],
    leaf_contents: impl Fn(usize) -> i32,
) -> Vec<ClipNode> {
    nodes
        .iter()
        .map(|n| {
            let child = |c: i16| -> i32 {
                if c >= 0 {
                    c as i32
                } else {
                    leaf_contents((-1 - c as i32) as usize)
                }
            };
            ClipNode {
                plane: n.plane,
                children: [child(n.children[0]), child(n.children[1])],
            }
        })
        .collect()
}

struct HullTree<'a> {
    nodes: &'a [ClipNode],
    planes: &'a [Plane],
    first: i32,
}

impl HullTree<'_> {
    fn contents(&self, mut num: i32, p: Vec3) -> i32 {
        while num >= 0 {
            let node = &self.nodes[num as usize];
            let plane = &self.planes[node.plane as usize];
            let d = plane.normal.dot(p) - plane.dist;
            num = node.children[if d < 0.0 { 1 } else { 0 }];
        }
        num
    }

    /// Returns true if the segment stayed in empty space so far.
    fn check(
        &self,
        num: i32,
        p1f: f32,
        p2f: f32,
        p1: Vec3,
        p2: Vec3,
        tr: &mut TraceResult,
    ) -> bool {
        if num < 0 {
            if num != CONTENTS_SOLID {
                tr.all_solid = false;
            } else {
                tr.start_solid = true;
            }
            return true;
        }

        let node = &self.nodes[num as usize];
        let plane = &self.planes[node.plane as usize];
        let t1 = plane.normal.dot(p1) - plane.dist;
        let t2 = plane.normal.dot(p2) - plane.dist;

        if t1 >= 0.0 && t2 >= 0.0 {
            return self.check(node.children[0], p1f, p2f, p1, p2, tr);
        }
        if t1 < 0.0 && t2 < 0.0 {
            return self.check(node.children[1], p1f, p2f, p1, p2, tr);
        }

        // The segment spans the plane: split.
        let frac = if t1 < 0.0 {
            (t1 + DIST_EPSILON) / (t1 - t2)
        } else {
            (t1 - DIST_EPSILON) / (t1 - t2)
        }
        .clamp(0.0, 1.0);
        let mut midf = p1f + (p2f - p1f) * frac;
        let mut mid = p1 + (p2 - p1) * frac;
        let side = usize::from(t1 < 0.0);

        // Near side first.
        if !self.check(node.children[side], p1f, midf, p1, mid, tr) {
            return false;
        }
        // Far side if it isn't solid at the crossing point.
        if self.contents(node.children[side ^ 1], mid) != CONTENTS_SOLID {
            return self.check(node.children[side ^ 1], midf, p2f, mid, p2, tr);
        }

        if tr.all_solid {
            return false; // never emerged from solid
        }

        if side == 0 {
            tr.normal = plane.normal;
        } else {
            tr.normal = -plane.normal;
        }

        // Back the impact point up off the surface until it's out of solid.
        let mut f = frac;
        while self.contents(self.first, mid) == CONTENTS_SOLID {
            f -= 0.1;
            if f < 0.0 {
                tr.fraction = midf;
                return false;
            }
            midf = p1f + (p2f - p1f) * f;
            mid = p1 + (p2 - p1) * f;
        }
        tr.fraction = midf;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unpruned_trace(col: &MapCollision, hull: Hull, start: Vec3, end: Vec3) -> TraceResult {
        let mut best = col.trace_model(0, hull, start, end);
        for &(model, offset) in &col.solids {
            if model >= col.models.len() {
                continue;
            }
            let t = col.trace_model_offset(model, offset, hull, start, end);
            if t.fraction < best.fraction || (t.start_solid && !best.start_solid) {
                best = t;
            }
        }
        best
    }

    fn assert_same(a: TraceResult, b: TraceResult) {
        assert_eq!(a.fraction, b.fraction);
        assert_eq!(a.end, b.end);
        assert_eq!(a.normal, b.normal);
        assert_eq!(a.start_solid, b.start_solid);
        assert_eq!(a.all_solid, b.all_solid);
    }

    #[test]
    fn brush_bounds_preserve_hits_inside_and_outside_translated_models() {
        let mut planes = Vec::new();
        let mut nodes = Vec::new();
        for axis in 0..3 {
            for sign in [1.0, -1.0] {
                let mut normal = Vec3::ZERO;
                normal[axis] = sign;
                let index = nodes.len();
                planes.push(Plane { normal, dist: 8.0 });
                nodes.push(ClipNode {
                    plane: index as u32,
                    children: [
                        CONTENTS_EMPTY,
                        if index == 5 {
                            CONTENTS_SOLID
                        } else {
                            index as i32 + 1
                        },
                    ],
                });
            }
        }
        let origin = Vec3::new(10.0, 20.0, -30.0);
        let offset = Vec3::new(40.0, -10.0, 100.0);
        let models = alloc::vec![
            ModelHulls {
                headnodes: [CONTENTS_EMPTY; 4],
                origin: Vec3::ZERO
            },
            ModelHulls {
                headnodes: [0; 4],
                origin
            },
        ];
        let col = MapCollision::from_parts(
            planes,
            nodes.clone(),
            nodes,
            models,
            alloc::vec![(1, offset)],
        );
        let bounds = col.model_bounds[1][0].unwrap();
        assert_eq!(bounds.mins, Vec3::splat(-8.0));
        assert_eq!(bounds.maxs, Vec3::splat(8.0));
        for hull in [Hull::Point, Hull::Stand, Hull::Crouch, Hull::Large] {
            for a in -12..=12 {
                for b in -12..=12 {
                    let start = origin + offset + Vec3::new(a as f32, -16.0, b as f32);
                    let end = origin + offset + Vec3::new(a as f32, 16.0, b as f32);
                    assert_same(
                        col.trace(hull, start, end),
                        unpruned_trace(&col, hull, start, end),
                    );
                    assert_same(
                        col.trace(hull, end.lerp(start, 0.5), start),
                        unpruned_trace(&col, hull, end.lerp(start, 0.5), start),
                    );
                }
            }
        }
    }

    #[test]
    fn unbounded_and_excessive_hulls_keep_exact_fallback() {
        let planes = [Plane {
            normal: Vec3::X,
            dist: 0.0,
        }];
        let half_space = [ClipNode {
            plane: 0,
            children: [CONTENTS_EMPTY, CONTENTS_SOLID],
        }];
        assert!(solid_bounds(&half_space, &planes, 0).is_none());
        let cycle = [ClipNode {
            plane: 0,
            children: [0, CONTENTS_EMPTY],
        }];
        assert!(solid_bounds(&cycle, &planes, 0).is_none());
    }

    #[cfg(feature = "std")]
    #[test]
    #[ignore = "requires POCKET3D_COOKED_MAPS containing user-supplied .p3d files"]
    fn real_map_brush_bounds_match_unpruned_traces() {
        let dir = std::env::var("POCKET3D_COOKED_MAPS").expect("local map directory");
        let mut maps = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "p3d") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let map = crate::cooked::read(&bytes).unwrap();
            let col = &map.collision;
            let mut seed = 0x12345678u32;
            let mut random = || {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 8) as f32 / 16777216.0
            };
            for _ in 0..2000 {
                let start = map.bounds.0
                    + (map.bounds.1 - map.bounds.0) * Vec3::new(random(), random(), random());
                let end =
                    start + (Vec3::new(random(), random(), random()) - Vec3::splat(0.5)) * 500.0;
                for hull in [Hull::Point, Hull::Stand, Hull::Crouch, Hull::Large] {
                    assert_same(
                        col.trace(hull, start, end),
                        unpruned_trace(col, hull, start, end),
                    );
                }
            }
            println!(
                "{}: 8000 matching traces; {} bounded model hulls",
                path.display(),
                col.model_bounds
                    .iter()
                    .flatten()
                    .filter(|b| b.is_some())
                    .count()
            );
            maps += 1;
        }
        assert!(maps > 0);
    }

    /// A one-plane "floor at y=0" hull: above empty, below solid.
    fn floor_tree() -> (Vec<ClipNode>, Vec<Plane>) {
        let planes = vec![Plane {
            normal: Vec3::Y,
            dist: 0.0,
        }];
        let nodes = vec![ClipNode {
            plane: 0,
            children: [CONTENTS_EMPTY, CONTENTS_SOLID],
        }];
        (nodes, planes)
    }

    #[test]
    fn trace_hits_floor() {
        let (nodes, planes) = floor_tree();
        let ht = HullTree {
            nodes: &nodes,
            planes: &planes,
            first: 0,
        };
        let mut tr = TraceResult::no_hit(Vec3::new(0.0, -10.0, 0.0));
        ht.check(
            0,
            0.0,
            1.0,
            Vec3::new(0.0, 10.0, 0.0),
            Vec3::new(0.0, -10.0, 0.0),
            &mut tr,
        );
        assert!(!tr.start_solid);
        assert!((tr.fraction - 0.5).abs() < 0.01, "fraction {}", tr.fraction);
        assert_eq!(tr.normal, Vec3::Y);
    }

    #[test]
    fn trace_misses_in_open() {
        let (nodes, planes) = floor_tree();
        let ht = HullTree {
            nodes: &nodes,
            planes: &planes,
            first: 0,
        };
        let mut tr = TraceResult::no_hit(Vec3::new(10.0, 5.0, 0.0));
        let stayed_open = ht.check(
            0,
            0.0,
            1.0,
            Vec3::new(0.0, 5.0, 0.0),
            Vec3::new(10.0, 5.0, 0.0),
            &mut tr,
        );
        assert!(stayed_open);
        assert_eq!(tr.fraction, 1.0);
        assert!(!tr.all_solid);
    }
}
