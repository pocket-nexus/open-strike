//! Brush entities per map: classes, and the breakables' and doors' keys.
use std::collections::BTreeMap;
fn main() -> anyhow::Result<()> {
    for path in std::env::args().skip(1) {
        let m = pocket3d_bsp::load_map(std::path::Path::new(&path), &[])?;
        let mut n: BTreeMap<String, usize> = BTreeMap::new();
        for e in &m.entities {
            if e.brush_model().is_some() {
                let c = e.classname();
                let key = if c == "func_breakable" {
                    format!(
                        "breakable material={} health={} rendermode={} amt={}",
                        e.get("material").unwrap_or("-"),
                        e.get("health").unwrap_or("-"),
                        e.get("rendermode").unwrap_or("-"),
                        e.get("renderamt").unwrap_or("-")
                    )
                } else if c.starts_with("func_door") {
                    format!(
                        "{c} spawnflags={} targetname={}",
                        e.get("spawnflags").unwrap_or("-"),
                        e.get("targetname").unwrap_or("-")
                    )
                } else {
                    c.to_string()
                };
                *n.entry(key).or_default() += 1;
            }
        }
        println!("{}:", m.name);
        for (k, v) in n {
            println!("   {v:3} {k}");
        }
    }
    Ok(())
}
