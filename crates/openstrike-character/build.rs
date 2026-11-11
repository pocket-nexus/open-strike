#[path = "src/format.rs"]
mod format;
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=OPENSTRIKE_CHARACTER_ASSET");
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let source = env::var_os("OPENSTRIKE_CHARACTER_ASSET")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("../../assets/characters/police/officer.opch"));
    let source = source
        .canonicalize()
        .expect("character asset does not exist");
    println!("cargo:rerun-if-changed={}", source.display());
    let data = fs::read(&source).expect("cannot read character asset");
    format::validate(&data).unwrap_or_else(|error| panic!("{}: {error}", source.display()));
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("character.opch");
    fs::write(&output, data).unwrap();
}
