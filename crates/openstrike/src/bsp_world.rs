//! OpenStrike's BSP adapter for the shared desktop geometry uploader.
use pocket3d::{geometry::*, gpu::Gpu, texture::Samplers};

pub fn upload(
    gpu: &Gpu,
    layout: &wgpu::BindGroupLayout,
    samplers: &Samplers,
    map: &pocket3d_bsp::MapData,
) -> WorldModel {
    use pocket3d_bsp::SurfaceKind;
    use pocket3d_bsp::lightmap::PAGE_SIZE;

    // Keep the BSP layout conversion at the application boundary.
    let vertices: Vec<WorldVertex> = map
        .geometry
        .vertices
        .iter()
        .map(|v| WorldVertex {
            pos: v.pos,
            uv: v.uv,
            lm_uv: v.lm_uv,
        })
        .collect();
    let batches: Vec<SourceBatch> = map
        .geometry
        .batches
        .iter()
        .map(|b| SourceBatch {
            texture: b.texture,
            lightmap_page: b.lm_page,
            kind: match b.kind {
                SurfaceKind::AlphaTest => WorldBatchKind::AlphaTest,
                SurfaceKind::Sky => WorldBatchKind::Sky,
                // Water renders as plain opaque for now.
                _ => WorldBatchKind::Opaque,
            },
            first_index: b.first_index,
            index_count: b.index_count,
        })
        .collect();
    let textures: Vec<SourceImage> = map
        .textures
        .iter()
        .map(|t| SourceImage {
            width: t.width,
            height: t.height,
            rgba: &t.rgba,
        })
        .collect();
    let lightmap_pages: Vec<SourceImage> = map
        .geometry
        .lightmap_pages
        .iter()
        .map(|p| SourceImage {
            width: PAGE_SIZE,
            height: PAGE_SIZE,
            rgba: p,
        })
        .collect();

    WorldModel::new(
        gpu,
        layout,
        samplers,
        &WorldSource {
            vertices: &vertices,
            indices: &map.geometry.indices,
            batches: &batches,
            textures,
            lightmap_pages,
        },
    )
}
