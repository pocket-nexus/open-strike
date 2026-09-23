use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rerun-if-env-changed=OPENSTRIKE_IPOD_MAPS");
    let mut names = Vec::new();
    if let Ok(root) = env::var("OPENSTRIKE_IPOD_MAPS") {
        println!("cargo:rerun-if-changed={root}");
        for file in fs::read_dir(root).unwrap() {
            let p = file.unwrap().path();
            if p.extension().and_then(|s| s.to_str()) == Some("p3d") {
                let name = p.file_stem().unwrap().to_str().unwrap().to_owned();
                assert!(name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'));
                names.push(name);
            }
        }
        assert!(!names.is_empty(), "No cooked maps");
    }
    names.sort();
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("maps.rs"),
        format!("pub const MAP_NAMES: &[&str] = &{names:?};\n"),
    )
    .unwrap();
}
