//! Prepare immutable draw groups once and refresh PVS membership on leaf changes.
use alloc::vec::Vec;
use glam::Vec3;
use pocket3d_bsp::{
    cooked::{bounds::RunBounds, cluster::ClusterCache, CookedMap},
    vis::{Frustum, VisSet},
    SurfaceKind,
};

pub struct WorldDraws {
    vis: VisSet,
    cache: Option<ClusterCache>,
    bounds: Vec<RunBounds>,
    entity_bounds: Vec<RunBounds>,
    visible: Vec<u16>,
}
impl WorldDraws {
    pub fn new(map: &CookedMap<'_>) -> Self {
        let bounds: Vec<_> = map.faces.iter().map(|r| RunBounds::new(map, *r)).collect();
        let entity_bounds: Vec<_> = map
            .always_runs
            .iter()
            .map(|r| RunBounds::new(map, *r))
            .collect();
        let cache = ClusterCache::new(map, None, &bounds, &entity_bounds);
        Self {
            vis: VisSet::new(map.faces.len()),
            cache,
            bounds,
            entity_bounds,
            visible: Vec::with_capacity(map.faces.len()),
        }
    }
    pub fn indices<'a>(&'a self, map: &'a CookedMap<'_>) -> &'a [u16] {
        self.cache.as_ref().map_or(map.indices, |c| &c.indices)
    }
    pub fn draw(
        &mut self,
        map: &CookedMap<'_>,
        eye: Vec3,
        frustum: &Frustum,
        mut emit: impl FnMut(u16, u32, u32) -> bool,
    ) -> bool {
        if self.vis.update(&map.vis, map.collision.planes(), eye) {
            if let Some(cache) = &mut self.cache {
                cache.update_visibility(self.vis.pvs_faces());
            } else {
                self.visible.clear();
                self.visible.extend_from_slice(self.vis.pvs_faces());
                self.visible.sort_unstable_by_key(|i| {
                    let r = map.faces[*i as usize];
                    (r.batch, r.index_base)
                });
            }
        }
        let visible = |batch: u16, bounds: &RunBounds| {
            batch != u16::MAX
                && bounds.visible(frustum)
                && (map.batches[batch as usize].kind == SurfaceKind::Water || bounds.facing(eye))
        };
        if let Some(cache) = &self.cache {
            for g in &cache.groups {
                if g.visible
                    && visible(g.batch, &g.bounds)
                    && !emit(g.batch, g.start as u32, g.count as u32)
                {
                    return false;
                }
            }
        } else {
            // Large maps retain the original indices; the sorted PVS list is
            // retained until a leaf transition, rather than sorted every frame.
            let mut pending: Option<(u16, u32, u32)> = None;
            for &id in &self.visible {
                let r = map.faces[id as usize];
                if !visible(r.batch, &self.bounds[id as usize]) || r.index_count == 0 {
                    continue;
                }
                if let Some((b, first, n)) = &mut pending {
                    if *b == r.batch && *first + *n == r.index_base {
                        *n += r.index_count as u32;
                        continue;
                    }
                    if !emit(*b, *first, *n) {
                        return false;
                    }
                }
                pending = Some((r.batch, r.index_base, r.index_count as u32));
            }
            if let Some((b, first, n)) = pending {
                if !emit(b, first, n) {
                    return false;
                }
            }
            for (r, b) in map.always_runs.iter().zip(&self.entity_bounds) {
                if r.index_count > 0
                    && visible(r.batch, b)
                    && !emit(r.batch, r.index_base, r.index_count as u32)
                {
                    return false;
                }
            }
        }
        true
    }
}
