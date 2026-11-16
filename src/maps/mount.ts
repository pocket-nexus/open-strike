// Puts a map into the scene, and takes the one before it out: its collision as one fixed triangle mesh (hidden: it
// is for bodies and bullets), what is seen (a GLB for an imported map, the map's own `build` for one made in code),
// its lamps, its sun and sky, its exposure. Every map goes through here, so an imported map and Foundry are the same
// thing to the rest of the game.
import {
  BufferGeometry, Color, Float32BufferAttribute, GLTFModel, Group, Mesh, MeshStandardMaterial, Object3D, PointLight, SkyAtmosphere, SkyColor, SpotLight,
  type DirectionalLight, type PerspectiveCamera, type Scene,
} from "@threert/scene";
import { isBuilt, type AnyMap } from "./index.ts";

export interface Mounted {
  map: AnyMap;
  group: Group;
}

/** The groups made for maps, kept while the map is (Foundry's takes tens of milliseconds to build, more than a frame
 *  has to spare when the player goes back to it from the Maps menu). */
const made = new Map<string, Mounted>();

/** Drops what was made for a map (one taken off this device, or replaced by another import). */
export function forgetMount(id: string): void {
  made.delete(id);
}

export function mountMap(scene: Scene, sun: DirectionalLight, camera: PerspectiveCamera, map: AnyMap, before?: Mounted): Mounted {
  if (before) scene.remove(before.group);
  const kept = made.get(map.id);
  const mounted = kept?.map === map ? kept : build(map);
  made.set(map.id, mounted);
  scene.add(mounted.group);
  light(map, scene, sun, camera);
  return mounted;
}

function build(map: AnyMap): Mounted {
  const group = new Group();
  group.name = `map ${map.id}`;

  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(map.collision.positions, 3));
  g.setIndex(map.collision.indices);
  // (Normals of its own, zeros: the mesh is never drawn. Without them the frame that first syncs it computes them in
  // script, tens of thousands of triangles at once, and on a handheld's CPU that is past a frame's 50 ms: the
  // runtime stops the frame script ("interrupted"), as it did on the Steam Deck the first time de_dust2 was played.)
  g.setAttribute("normal", new Float32BufferAttribute(new Float32Array(map.collision.positions.length), 3));
  const collision = new Mesh(g, new MeshStandardMaterial({ name: "collision" }));
  collision.name = "collision";
  collision.visible = false;
  collision.castShadow = false;
  collision.physics = { type: "fixed", shape: "mesh", friction: 0.8 };
  group.add(collision);

  if (map.glb) {
    // (An engine older than the store's `user:` assets refuses the name: the map is then played undrawn, its collision
    // and lamps as they are, rather than not at all.)
    try {
      const model = new GLTFModel(map.glb);
      model.name = "map model";
      group.add(model);
    } catch (e) {
      console.warn(`map ${map.id}: its model ${map.glb} cannot be loaded here (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (isBuilt(map)) map.build(group);

  (map.lights ?? []).forEach((l, i) => {
    const color = new Color(l.color);
    let light: PointLight | SpotLight;
    if (l.type === "spot") {
      const half = l.angle ?? Math.PI / 4;
      // Lumens into the cone -> candela.
      const spot = new SpotLight(color, l.power / (2 * Math.PI * (1 - Math.cos(half))), 0, half, 0.5);
      spot.target = new Object3D();
      spot.target.position.set(...(l.target ?? [l.position[0], l.position[1] - 1, l.position[2]]));
      light = spot;
    } else {
      light = new PointLight(color, l.power / (4 * Math.PI));
    }
    light.radius = l.radius ?? 0.05;
    light.name = `map light ${i}`;
    light.position.set(...l.position);
    group.add(light);
  });
  return { map, group };
}

function light(map: AnyMap, scene: Scene, sun: DirectionalLight, camera: PerspectiveCamera): void {
  // The sun and the sky. (Azimuth and elevation as `DirectionalLight.setSunAngles` takes them: degrees, azimuth 0 is
  // a sun in the +Z sky, its light travelling toward -Z; 90 a sun in the +X sky.)
  if (map.sun) {
    sun.color = new Color(map.sun.color ?? 0xffffff);
    sun.intensity = map.sun.illuminance;
    sun.setSunAngles(map.sun.elevation, map.sun.azimuth);
  } else {
    sun.intensity = 0;
    sun.setSunAngles(-30, 0);
  }
  const sky = map.sky ?? "atmosphere";
  scene.environment = sky === "atmosphere" ? new SkyAtmosphere({ sun }) : new SkyColor(new Color(sky.color), sky.intensity);
  if (map.exposure !== undefined) camera.setManualExposure(map.exposure);
  else camera.setAutoExposure(0, 7, 15);
}
