//! How much of a map's walk graph each side's first spawn reaches, and where the two sides' reach ends.
use openstrike_game::nav::Nav;
use openstrike_game::world::Map;
fn main() -> anyhow::Result<()> {
    for path in std::env::args().skip(1) {
        let map = Map::load(std::path::Path::new(&path))?;
        let nav = Nav::build(&map);
        let reach = |from: u32| {
            let mut seen = vec![false; nav.nodes.len()];
            let mut stack = vec![from];
            seen[from as usize] = true;
            while let Some(i) = stack.pop() {
                for &(j, _) in &nav.nodes[i as usize].links {
                    if !seen[j as usize] {
                        seen[j as usize] = true;
                        stack.push(j);
                    }
                }
            }
            seen
        };
        let a = nav.nearest(map.spawns[0][0].pos).unwrap();
        let b = nav.nearest(map.spawns[1][0].pos).unwrap();
        let (ra, rb) = (reach(a), reach(b));
        let n = |r: &Vec<bool>| r.iter().filter(|x| **x).count();
        println!(
            "{}: {} nodes; from side 0: {} (reaches side 1: {}), from side 1: {} (reaches side 0: {})",
            map.name,
            nav.nodes.len(),
            n(&ra),
            ra[b as usize],
            n(&rb),
            rb[a as usize]
        );
        // Where side 0's reach stops next to nodes it does not reach: the nearest such pair.
        if !ra[b as usize] {
            let mut best = (f32::MAX, 0usize, 0usize);
            for (i, x) in nav.nodes.iter().enumerate().filter(|(i, _)| ra[*i]) {
                for (j, y) in nav
                    .nodes
                    .iter()
                    .enumerate()
                    .filter(|(j, _)| !ra[*j] && rb[*j])
                {
                    let d = (x.pos - y.pos).length();
                    if d < best.0 {
                        best = (d, i, j);
                    }
                }
            }
            println!(
                "  nearest gap: {:.0} units between {:?} (side 0's) and {:?}",
                best.0, nav.nodes[best.1].pos, nav.nodes[best.2].pos
            );
        }
    }
    Ok(())
}
