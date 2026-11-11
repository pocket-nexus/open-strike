//! Export the validated PSP geometry/light colors and textures for a static viewer.
use pocket3d_bsp::{cook::verify_cooked_textures, cooked, types::SurfaceKind};
use serde_json::json;
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 3 {
        return Err("export_map_site MAP.p3d OUTPUT_DIR".into());
    }
    let data = fs::read(&args[1])?;
    let map = cooked::read(&data)?;
    verify_cooked_textures(&map)?;
    let out = PathBuf::from(&args[2]);
    fs::create_dir_all(&out)?;
    let mut geometry = map.verts.to_vec();
    while geometry.len() % 4 != 0 {
        geometry.push(0);
    }
    let index_offset = geometry.len();
    for index in map.indices {
        geometry.extend_from_slice(&index.to_le_bytes());
    }
    fs::write(out.join("geometry.bin"), &geometry)?;
    let mut textures = Vec::new();
    for (index, texture) in map.textures.iter().enumerate() {
        let mut rgba = cooked::expand_level0_rgba(texture)
            .map_err(|e| format!("texture {}: {e:?}", texture.name))?;
        // Preserve the cooked CLUT's filter color at zero-alpha edges, as on GE.
        for pixel in rgba.chunks_exact_mut(4) {
            if pixel[3] == 0 {
                pixel[..3].copy_from_slice(&texture.palette[1020..1023]);
            }
        }
        let file = format!("texture-{index}.rgba");
        fs::write(out.join(&file), rgba)?;
        textures.push(
            json!({"file":file,"name":texture.name,"width":texture.width,"height":texture.height}),
        );
    }
    let batches: Vec<_> = map
        .batches
        .iter()
        .map(|b| {
            json!({
                "texture":b.texture,"alphaTest":b.kind == SurfaceKind::AlphaTest,
                "vertexBase":b.vert_base,"vertexCount":b.vert_count,
                "indexBase":b.index_base,"indexCount":b.index_count
            })
        })
        .collect();
    let sky = map
        .sky
        .map(|s| (s.zenith.to_array(), s.horizon.to_array()))
        .unwrap_or(([0.34, 0.48, 0.66], [0.93, 0.79, 0.62]));
    let spawns: Vec<_> = map
        .ct_spawns
        .iter()
        .map(|s| json!({"position":(s.pos + glam::Vec3::Y*28.0).to_array(),"yaw":s.yaw,"pitch":0}))
        .collect();
    let scene = json!({
        "version":1,"name":map.name,"vertexStride":cooked::VERTEX_STRIDE,
        "vertexCount":map.vert_count,"indexOffset":index_offset,"indexCount":map.indices.len(),
        "geometryBytes":geometry.len(),"triangles":map.indices.len()/3,
        "batches":batches,"textures":textures,"spawns":spawns,
        "bounds":[map.bounds.0.to_array(),map.bounds.1.to_array()],
        "sky":{"zenith":sky.0,"horizon":sky.1}
    });
    fs::write(out.join("scene.json"), serde_json::to_vec_pretty(&scene)?)?;
    println!(
        "exported {} vertices, {} triangles, {} textures",
        map.vert_count,
        map.indices.len() / 3,
        map.textures.len()
    );
    Ok(())
}
