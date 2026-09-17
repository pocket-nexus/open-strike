// SPDX-License-Identifier: MIT
//! Adapt the game's existing cooked maps to the desktop renderer. Texture
//! expansion and collision parsing stay in the shared Pocket3D format reader.
use anyhow::{Context, Result, anyhow};
use pocket3d::bsp::{
    Batch, DecodedTexture, MapData, MapGeometry, WorldVertexData, cooked,
    lightmap::{LightmapAtlas, PAGE_SIZE},
    mesh::GeometryStats,
};
use std::path::Path;

pub fn load(path: &Path) -> Result<MapData> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    decode(&bytes)
}

fn decode(bytes: &[u8]) -> Result<MapData> {
    let map = cooked::read(bytes).map_err(|e| anyhow!("cooked map: {e}"))?;
    let textures = map
        .textures
        .iter()
        .map(|t| {
            Ok(DecodedTexture {
                name: t.name.clone(),
                width: t.width,
                height: t.height,
                has_alpha: t.masked,
                rgba: cooked::expand_level0_rgba(t)
                    .map_err(|e| anyhow!("texture {}: {e:?}", t.name))?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut atlas = LightmapAtlas::new();
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let mut batches: Vec<Batch> = Vec::new();
    for batch in &map.batches {
        let source = &map.indices
            [batch.index_base as usize..(batch.index_base + batch.index_count) as usize];
        for triangle in source.chunks_exact(3) {
            let triangle: [u16; 3] = triangle.try_into().unwrap();
            let corners = triangle.map(|index| {
                let offset = (batch.vert_base as usize + index as usize) * cooked::VERTEX_STRIDE;
                let v = &map.verts[offset..offset + cooked::VERTEX_STRIDE];
                WorldVertexData {
                    pos: [12, 14, 16]
                        .map(|o| i16::from_le_bytes(v[o..o + 2].try_into().unwrap()) as f32),
                    uv: [0, 4].map(|o| f32::from_le_bytes(v[o..o + 4].try_into().unwrap())),
                    lm_uv: [0.0; 2],
                }
            });
            let colors = triangle.map(|index| {
                let o = (batch.vert_base as usize + index as usize) * cooked::VERTEX_STRIDE + 8;
                [map.verts[o], map.verts[o + 1], map.verts[o + 2]]
            });
            // Cooked maps carry overbright vertex colors; desktop lightmaps
            // apply that factor in the shader. A small padded triangle patch
            // interpolates the same lighting without changing world shaders.
            let patch = lighting_patch(colors);
            let allocation = atlas.insert_rgb(8, 8, Some(&patch));
            let lm_uv = [
                [allocation.x as f32 + 0.5, allocation.y as f32 + 0.5],
                [allocation.x as f32 + 7.5, allocation.y as f32 + 0.5],
                [allocation.x as f32 + 0.5, allocation.y as f32 + 7.5],
            ];
            let first = indices.len() as u32;
            for (i, mut v) in corners.into_iter().enumerate() {
                v.lm_uv = lm_uv[i].map(|n| n / PAGE_SIZE as f32);
                indices.push(vertices.len() as u32);
                vertices.push(v);
            }
            if let Some(last) = batches.last_mut().filter(|b| {
                b.texture == batch.texture as usize
                    && b.kind == batch.kind
                    && b.lm_page == allocation.page
            }) {
                last.index_count += 3;
            } else {
                batches.push(Batch {
                    texture: batch.texture as usize,
                    lm_page: allocation.page,
                    kind: batch.kind,
                    first_index: first,
                    index_count: 3,
                });
            }
        }
    }
    let stats = GeometryStats {
        faces_drawn: map.faces.len(),
        faces_skipped: 0,
        triangles: indices.len() / 3,
    };
    Ok(MapData {
        name: map.name,
        geometry: MapGeometry {
            vertices,
            indices,
            batches,
            lightmap_pages: atlas.pages,
            stats,
        },
        textures,
        entities: Vec::new(),
        collision: map.collision,
        ct_spawns: map.ct_spawns,
        t_spawns: map.t_spawns,
        sun: map.sun,
        bounds: map.bounds,
    })
}

fn lighting_patch(colors: [[u8; 3]; 3]) -> Vec<u8> {
    let mut result = Vec::with_capacity(8 * 8 * 3);
    for y in 0..8 {
        for x in 0..8 {
            for c in 0..3 {
                let u = x as f32 / 7.0;
                let v = y as f32 / 7.0;
                result.push(
                    ((colors[0][c] as f32 * (1.0 - u - v)
                        + colors[1][c] as f32 * u
                        + colors[2][c] as f32 * v)
                        / 2.0)
                        .clamp(0.0, 127.5)
                        .round() as u8,
                );
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lighting_preserves_corners_and_constant_brightness() {
        let colors = [[40, 60, 80], [120, 100, 60], [80, 160, 140]];
        let patch = lighting_patch(colors);
        for (corner, offset) in [0, 7 * 3, 7 * 8 * 3].into_iter().enumerate() {
            assert_eq!(&patch[offset..offset + 3], &colors[corner].map(|v| v / 2));
        }
        assert!(lighting_patch([[120; 3]; 3]).iter().all(|&v| v == 60));
    }
    #[test]
    fn malformed_cooked_map_is_an_error() {
        assert!(decode(b"P3D1 incomplete").is_err());
    }
    #[test]
    fn supplied_map_keeps_collision_spawns_and_texture_dimensions() {
        let Ok(path) = std::env::var("OPENSTRIKE_TEST_P3D") else {
            return;
        };
        let bytes = std::fs::read(path).unwrap();
        let original = cooked::read(&bytes).unwrap();
        let desktop = decode(&bytes).unwrap();
        assert_eq!(desktop.ct_spawns.len(), original.ct_spawns.len());
        assert_eq!(desktop.t_spawns.len(), original.t_spawns.len());
        assert_eq!(desktop.bounds, original.bounds);
        assert_eq!(desktop.geometry.indices.len(), original.indices.len());
        assert!(!desktop.ct_spawns.is_empty());
        for (texture, cooked) in desktop.textures.iter().zip(original.textures.iter()) {
            assert_eq!(
                (texture.width, texture.height),
                (cooked.width, cooked.height)
            );
            assert_eq!(
                texture.rgba.len(),
                (texture.width * texture.height * 4) as usize
            );
        }
    }
}
