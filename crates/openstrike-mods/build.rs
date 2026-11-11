use serde_json::{Value, json};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
#[path = "../openstrike-character/src/format.rs"]
mod character;
// The build-time validator only needs the byte contract, not the runtime view.
#[allow(dead_code)]
#[path = "src/viewmodel.rs"]
mod viewmodel;

fn read(path: &Path) -> Vec<u8> {
    println!("cargo:rerun-if-changed={}", path.display());
    fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}
fn text<'a>(v: &'a Value, key: &str, max: usize) -> &'a str {
    let s = v[key].as_str().unwrap_or_else(|| panic!("missing {key}"));
    assert!(
        !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control),
        "invalid {key}"
    );
    s
}
fn number(v: &Value, key: &str, low: f64, high: f64, integer: bool) {
    let n = v[key]
        .as_f64()
        .unwrap_or_else(|| panic!("missing number {key}"));
    assert!(
        n.is_finite() && n >= low && n <= high && (!integer || n.fract() == 0.0),
        "invalid {key}"
    );
}
fn main() {
    for name in [
        "OPENSTRIKE_MOD_PACKS",
        "OPENSTRIKE_INITIAL_MOD",
        "OPENSTRIKE_CHARACTER_ASSET",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let default = root.join("mods/classic.json");
    let mut manifests = vec![(
        default.clone(),
        serde_json::from_slice::<Value>(&read(&default)).unwrap(),
    )];
    let paths: Vec<PathBuf> =
        serde_json::from_str(&env::var("OPENSTRIKE_MOD_PACKS").unwrap_or("[]".into()))
            .expect("mod paths must be a JSON array");
    assert!(paths.len() < 8, "at most seven additional mod packs");
    for path in paths {
        let path = path.canonicalize().expect("mod manifest missing");
        manifests.push((
            path.clone(),
            serde_json::from_slice(&read(&path)).expect("invalid mod JSON"),
        ));
    }
    if let Some(path) = env::var_os("OPENSTRIKE_CHARACTER_ASSET").filter(|s| !s.is_empty()) {
        assert!(manifests.len() == 1, "use --character or --mod, not both");
        let mut legacy = manifests[0].1.clone();
        legacy["id"] = json!("local");
        legacy["title"] = json!("Local Character");
        legacy["description"] = json!("Local character / rifle");
        legacy["character"] = json!(PathBuf::from(path).canonicalize().unwrap());
        manifests.push((default, legacy));
    }
    let mut metadata = Vec::new();
    let mut packs = String::new();
    let mut payload = 0;
    for (index, (path, v)) in manifests.iter().enumerate() {
        assert_eq!(v["schema"], 1, "unsupported mod schema");
        let id = text(v, "id", 32);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "invalid mod id"
        );
        assert!(
            !metadata.iter().any(|m: &Value| m["id"] == id),
            "duplicate mod id"
        );
        text(v, "title", 32);
        text(v, "description", 96);
        text(&v["hud"], "reload", 32);
        text(&v["hud"], "weapon", 24);
        for key in ["magSize", "reserve"] {
            number(&v["weapon"], key, 1., 999., true);
        }
        for key in ["fireInterval", "reloadTime"] {
            number(&v["weapon"], key, 0.05, 30., false);
        }
        for key in ["damageBody", "damageHead"] {
            number(&v["weapon"], key, 1., 1000., true);
        }
        number(&v["bots"], "count", 0., 16., true);
        number(&v["bots"], "speed", 1., 500., false);
        number(&v["bots"], "attackInterval", 0.1, 30., false);
        for key in ["damageMin", "damageMax"] {
            number(&v["bots"], key, 1., 1000., true);
        }
        assert!(v["bots"]["damageMin"].as_f64() <= v["bots"]["damageMax"].as_f64());
        let effect = match v["effects"].as_str() {
            Some("flame") => "Flame",
            Some("beam") => "Beam",
            Some("orb") => "Orb",
            _ => panic!("unknown effect profile"),
        };
        let motion = match v["viewMotion"].as_str() {
            None if v["viewMotion"].is_null() => "Rifle",
            Some("rifle") => "Rifle",
            Some("staff") => "Staff",
            Some("throw") => "Throw",
            _ => panic!("unknown view motion"),
        };
        let mut projectile = "None".to_string();
        let mut projectile_mesh = "None".to_string();
        if !v["projectile"].is_null() {
            let spec = &v["projectile"];
            for (key, low, high) in [
                ("speed", 100., 2000.),
                ("gravity", 0., 1200.),
                ("lift", 0., 300.),
                ("radius", 0.5, 8.),
                ("lifetime", 0.1, 5.),
            ] {
                number(spec, key, low, high, false);
            }
            let fields = ["speed", "gravity", "lift", "radius", "lifetime"]
                .map(|key| format!("{key}:{}f32", spec[key].as_f64().unwrap()))
                .join(",");
            projectile = format!("Some(ProjectileConfig{{{fields}}})");
            let mesh_path = text(spec, "mesh", 256);
            let bytes = read(&path.parent().unwrap().join(mesh_path));
            viewmodel::validate(&bytes).expect("invalid projectile mesh");
            payload += bytes.len();
            fs::write(out.join(format!("projectile-{index}.opvm")), bytes).unwrap();
            projectile_mesh = format!(
                "Some(include_bytes!(concat!(env!(\"OUT_DIR\"),\"/projectile-{index}.opvm\")))"
            );
        }
        assert!(
            (effect == "Orb") == (projectile != "None"),
            "orb effects require ballistic delivery and vice versa"
        );
        assert!(
            v["character"].is_null() || v["character"].is_string(),
            "invalid character path"
        );
        let char_path = v["character"]
            .as_str()
            .map(|s| path.parent().unwrap().join(s))
            .unwrap_or(root.join("assets/characters/police/officer.opch"));
        let bytes = read(&char_path);
        character::validate(&bytes).expect("invalid mod character");
        payload += bytes.len();
        fs::write(out.join(format!("character-{index}.opch")), bytes).unwrap();
        let mesh = if let Some(name) = v["viewmodel"].as_str() {
            let bytes = read(&path.parent().unwrap().join(name));
            viewmodel::validate(&bytes).expect("invalid mod viewmodel");
            payload += bytes.len();
            fs::write(out.join(format!("viewmodel-{index}.opvm")), bytes).unwrap();
            format!("Some(include_bytes!(concat!(env!(\"OUT_DIR\"),\"/viewmodel-{index}.opvm\")))")
        } else {
            assert!(v["viewmodel"].is_null());
            "None".into()
        };
        assert!(
            payload <= 8 * 1024 * 1024,
            "mod bundle exceeds 8 MiB baked resource budget"
        );
        packs += &format!(
            "ModPack{{id:{id:?},character:include_bytes!(concat!(env!(\"OUT_DIR\"),\"/character-{index}.opch\")),viewmodel:{mesh},effects:ShotStyle::{effect},motion:ViewMotion::{motion},projectile:{projectile},projectile_mesh:{projectile_mesh}}},\n"
        );
        metadata.push(json!({"id":id,"title":v["title"],"description":v["description"],"weapon":v["weapon"],"bots":v["bots"],"hud":v["hud"]}));
    }
    let initial = env::var("OPENSTRIKE_INITIAL_MOD")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|id| {
            metadata
                .iter()
                .position(|m| m["id"] == id)
                .expect("initial mod is not in this package")
        })
        .unwrap_or(if metadata.len() > 1 { 1 } else { 0 });
    fs::write(out.join("catalog.rs"),format!("pub static PACKS: &[ModPack] = &[{packs}];\npub const METADATA: &str = {:?};\npub const INITIAL: usize = {initial};\n",serde_json::to_string(&metadata).unwrap())).unwrap();
}
