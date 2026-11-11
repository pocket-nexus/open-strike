//! Where bots can walk: a graph flooded from the spawn points over a 32-unit grid with the standing hull (steps up to
//! 18 units, drops as one-way links), shortest paths over it (A*), and cover from a threat.
use crate::util::Rng;
use crate::world::Map;
use glam::Vec3;
use pocket3d_bsp::trace::Hull;
use std::cell::RefCell;
use std::collections::{BinaryHeap, HashMap, VecDeque};

pub const CELL: f32 = 32.0;
const STEP: f32 = 18.0;
const MAX_DROP: f32 = 170.0;
/// Ledges up to this high are climbed (the actor's mantle reaches 76 above the feet).
const CLIMB: f32 = 62.0;
const MAX_NODES: usize = 48_000;
pub const NONE: u32 = u32::MAX;

pub struct Node {
    /// Standing hull centre on the ground.
    pub pos: Vec3,
    /// (to, cost).
    pub links: Vec<(u32, f32)>,
    /// How much solid stands close around the node at chest height, per 8 directions (bit set = a wall within 56
    /// units): cover from that side.
    pub walls: u8,
}

#[derive(Default)]
struct Scratch {
    stamp: Vec<u32>,
    g: Vec<f32>,
    from: Vec<u32>,
    gen_id: u32,
}

pub struct Nav {
    pub nodes: Vec<Node>,
    cells: HashMap<(i32, i32), Vec<u32>>,
    scratch: RefCell<Scratch>,
}

#[derive(PartialEq)]
struct Open(f32, u32);
impl Eq for Open {}
impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Open) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Open {
    fn cmp(&self, o: &Open) -> std::cmp::Ordering {
        o.0.total_cmp(&self.0)
    }
}

const DIRS: [(i32, i32); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];

fn cell_of(p: Vec3) -> (i32, i32) {
    ((p.x / CELL).round() as i32, (p.z / CELL).round() as i32)
}

impl Nav {
    pub fn build(map: &Map) -> Nav {
        let mut nav = Nav {
            nodes: vec![],
            cells: HashMap::new(),
            scratch: RefCell::default(),
        };
        let mut queue = VecDeque::new();
        for s in map.spawns.iter().flatten() {
            // The spawn's own cell centre, or a neighbour's, where the hull fits and the spawn can walk to.
            let (cx, cz) = cell_of(s.pos);
            'seed: for (dx, dz) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                let p = Vec3::new(
                    (cx + dx) as f32 * CELL,
                    s.pos.y + 2.0,
                    (cz + dz) as f32 * CELL,
                );
                if map.hull(Hull::Stand, s.pos + Vec3::Y * 2.0, p).fraction < 1.0 {
                    continue;
                }
                if let Some(g) = map.settle(p) {
                    if nav.find(g).is_none() {
                        queue.push_back(nav.add(g));
                    }
                    break 'seed;
                }
            }
        }
        while let Some(i) = queue.pop_front() {
            let p = nav.nodes[i as usize].pos;
            for (dx, dz) in DIRS {
                let d = Vec3::new(dx as f32 * CELL, 0.0, dz as f32 * CELL);
                let Some(q) = probe(map, p, d) else { continue };
                let j = match nav.find(q) {
                    Some(j) => j,
                    None if nav.nodes.len() < MAX_NODES => {
                        let j = nav.add(q);
                        queue.push_back(j);
                        j
                    }
                    None => continue,
                };
                // A drop costs a little, a climb (a ledge to jump or pull up onto) more.
                let drop = p.y - q.y;
                let cost = d.length()
                    * if drop > STEP {
                        1.6 + drop / 120.0
                    } else if drop < -STEP {
                        3.0
                    } else {
                        1.0
                    };
                nav.nodes[i as usize].links.push((j, cost));
            }
        }
        // Walls around each node (cover), and a little cost on hugging them (paths keep off the corners).
        for i in 0..nav.nodes.len() {
            let p = nav.nodes[i].pos + Vec3::Y * 4.0;
            let mut walls = 0u8;
            for (k, (dx, dz)) in DIRS.iter().enumerate() {
                let d = Vec3::new(*dx as f32, 0.0, *dz as f32).normalize();
                if map.ray(p, p + d * 56.0).fraction < 1.0 {
                    walls |= 1 << k;
                }
            }
            nav.nodes[i].walls = walls;
        }
        nav
    }

    fn add(&mut self, pos: Vec3) -> u32 {
        let i = self.nodes.len() as u32;
        self.nodes.push(Node {
            pos,
            links: Vec::new(),
            walls: 0,
        });
        self.cells.entry(cell_of(pos)).or_default().push(i);
        i
    }

    /// The node of `p`'s cell at `p`'s height.
    fn find(&self, p: Vec3) -> Option<u32> {
        self.cells
            .get(&cell_of(p))?
            .iter()
            .copied()
            .find(|&i| (self.nodes[i as usize].pos.y - p.y).abs() < 24.0)
    }

    /// The node nearest a hull centre (within a few cells, at about its height).
    pub fn nearest(&self, p: Vec3) -> Option<u32> {
        let (cx, cz) = cell_of(p);
        for r in [1, 3, 6] {
            let mut best: Option<(f32, u32)> = None;
            for x in cx - r..=cx + r {
                for z in cz - r..=cz + r {
                    for &i in self.cells.get(&(x, z)).map(Vec::as_slice).unwrap_or(&[]) {
                        let q = self.nodes[i as usize].pos;
                        let dy = (q.y - p.y).abs();
                        let d = (q - p).length() + if dy > 40.0 { dy * 4.0 } else { 0.0 };
                        if best.is_none_or(|(b, _)| d < b) {
                            best = Some((d, i));
                        }
                    }
                }
            }
            if let Some((_, i)) = best {
                return Some(i);
            }
        }
        None
    }

    pub fn pos(&self, i: u32) -> Vec3 {
        self.nodes[i as usize].pos
    }

    pub fn random(&self, rng: &mut Rng) -> u32 {
        rng.below(self.nodes.len()) as u32
    }

    /// The cheapest path (node ids, `from` excluded, `to` included). `cost` adds to each node's price (danger).
    pub fn path(&self, from: u32, to: u32, cost: &dyn Fn(u32) -> f32) -> Option<Vec<u32>> {
        if from == to {
            return Some(vec![]);
        }
        let n = self.nodes.len();
        let mut sc = self.scratch.borrow_mut();
        if sc.stamp.len() != n {
            sc.stamp = vec![0; n];
            sc.g = vec![0.0; n];
            sc.from = vec![NONE; n];
            sc.gen_id = 0;
        }
        sc.gen_id += 1;
        let id = sc.gen_id;
        let goal = self.nodes[to as usize].pos;
        let mut open = BinaryHeap::new();
        sc.stamp[from as usize] = id;
        sc.g[from as usize] = 0.0;
        sc.from[from as usize] = NONE;
        open.push(Open((self.nodes[from as usize].pos - goal).length(), from));
        let mut expanded = 0;
        while let Some(Open(f, i)) = open.pop() {
            if i == to {
                let mut out = vec![to];
                let mut k = sc.from[to as usize];
                while k != NONE && k != from {
                    out.push(k);
                    k = sc.from[k as usize];
                }
                out.reverse();
                return Some(out);
            }
            let gi = sc.g[i as usize];
            if f > gi + (self.nodes[i as usize].pos - goal).length() + 0.01 {
                continue;
            }
            expanded += 1;
            if expanded > 30_000 {
                break;
            }
            for &(j, c) in &self.nodes[i as usize].links {
                let g = gi + c + cost(j);
                let ju = j as usize;
                if sc.stamp[ju] != id || g < sc.g[ju] {
                    sc.stamp[ju] = id;
                    sc.g[ju] = g;
                    sc.from[ju] = i;
                    open.push(Open(g + (self.nodes[ju].pos - goal).length(), j));
                }
            }
        }
        None
    }

    /// Nodes within `steps` links of `from`, nearest first (with their depth).
    pub fn around(&self, from: u32, steps: u32, max: usize) -> Vec<(u32, u32)> {
        let mut seen = HashMap::new();
        let mut out = vec![];
        let mut queue = VecDeque::from([(from, 0u32)]);
        seen.insert(from, ());
        while let Some((i, d)) = queue.pop_front() {
            out.push((i, d));
            if out.len() >= max {
                break;
            }
            if d >= steps {
                continue;
            }
            for &(j, _) in &self.nodes[i as usize].links {
                if seen.insert(j, ()).is_none() {
                    queue.push_back((j, d + 1));
                }
            }
        }
        out
    }

    /// A node near `from` that the threat (an eye) cannot see: (node, whether only a crouch hides there).
    pub fn cover(&self, map: &Map, from: u32, threat: Vec3, steps: u32) -> Option<(u32, bool)> {
        let mut best: Option<(f32, u32, bool)> = None;
        for (i, depth) in self.around(from, steps, 220) {
            let n = &self.nodes[i as usize];
            if n.walls == 0 {
                continue;
            }
            let (head, chest, low) = (
                n.pos + Vec3::Y * 28.0,
                n.pos + Vec3::Y * 8.0,
                n.pos - Vec3::Y * 8.0,
            );
            let stand_hidden = !map.los(threat, head) && !map.los(threat, chest);
            let crouch_hidden = !map.los(threat, low) && !map.los(threat, chest - Vec3::Y * 6.0);
            if !stand_hidden && !crouch_hidden {
                continue;
            }
            let dist = (n.pos - threat).length();
            // Near is good; standing cover is better than a crouch; not within arm's reach of the threat.
            let score = depth as f32 * 32.0
                + if stand_hidden { 0.0 } else { 90.0 }
                + if dist < 260.0 { 400.0 } else { 0.0 };
            if best.is_none_or(|(s, _, _)| score < s) {
                best = Some((score, i, !stand_hidden));
            }
        }
        best.map(|(_, i, crouch)| (i, crouch))
    }

    /// Whether a hull can walk straight from `a` to `b` (no wall, no ledge, about level).
    pub fn walkable(&self, map: &Map, a: Vec3, b: Vec3) -> bool {
        if (a.y - b.y).abs() > STEP {
            return false;
        }
        let up = Vec3::Y * 2.0;
        if map.hull(Hull::Stand, a + up, b + up).fraction < 1.0 {
            return false;
        }
        let n = ((b - a).length() / 28.0).ceil().max(1.0) as usize;
        (1..n).all(|k| {
            let p = a + (b - a) * (k as f32 / n as f32) + up;
            map.hull(Hull::Stand, p, p - Vec3::Y * (STEP + 6.0))
                .fraction
                < 1.0
        })
    }
}

/// One step of the flood: from a standing hull centre `p` by `d` (horizontal), up to a stair's height up or a drop
/// down; or, where a ledge is in the way, up onto it (a jump or a mantle: `CLIMB` units at most).
fn probe(map: &Map, p: Vec3, d: Vec3) -> Option<Vec3> {
    let up = map.hull(Hull::Stand, p, p + Vec3::Y * STEP);
    let u = up.end;
    let mut f = map.hull(Hull::Stand, u, u + d);
    if f.fraction < 1.0 || f.start_solid {
        // Blocked at a stair's height: over a ledge, with the headroom to rise by it. Straight steps only (a body
        // pulls up square onto a ledge).
        if d.x != 0.0 && d.z != 0.0 {
            return None;
        }
        let high = map.hull(Hull::Stand, p, p + Vec3::Y * CLIMB);
        if high.fraction < 1.0 {
            return None;
        }
        f = map.hull(Hull::Stand, high.end, high.end + d);
        if f.fraction < 1.0 || f.start_solid {
            return None;
        }
        let down = map.hull(Hull::Stand, f.end, f.end - Vec3::Y * (CLIMB + 2.0));
        return (!down.start_solid
            && down.fraction < 1.0
            && down.normal.y >= 0.7
            && down.end.y - p.y > STEP)
            .then_some(down.end);
    }
    let down = map.hull(
        Hull::Stand,
        f.end,
        f.end - Vec3::Y * (u.y - p.y + STEP + MAX_DROP),
    );
    if down.start_solid || down.fraction >= 1.0 || down.normal.y < 0.7 {
        return None;
    }
    Some(down.end)
}
