"""Bake a local animated GLB to OpenStrike's textured handheld character format.

Run with Blender --background --factory-startup --python-exit-code 1 --python
scripts/bake-character.py -- --source /path/character.glb --output out/character.opch
The source, texture, poses and preview outputs stay local; this script contains
no third-party geometry. The openworld profile maps its five authored actions
onto OpenStrike's seven semantic actions without changing AI or collision.
"""
import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector, Quaternion

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--socket', default='staff.tip')
parser.add_argument('--grip', default='staff.R')
parser.add_argument('--drop-mesh', default='staff')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(args.source.resolve()))
scene = bpy.context.scene
rigs = [o for o in scene.objects if o.type == 'ARMATURE']
if len(rigs) != 1:
    raise RuntimeError('expected one skinned character armature')
rig = rigs[0]
meshes = sorted([o for o in scene.objects if o.type == 'MESH' and any(
    m.type == 'ARMATURE' and m.object == rig for m in o.modifiers)], key=lambda o: o.name)
if not meshes:
    raise RuntimeError('no skinned meshes')
for track in rig.animation_data.nla_tracks:
    track.mute = True
rig.animation_data.use_nla = False
for name in ['Idle', 'Walk', 'Cast', 'Water']:
    if name not in bpy.data.actions:
        raise RuntimeError(f'missing source action {name}')
for bone in [args.socket, args.grip]:
    if bone not in rig.pose.bones:
        raise RuntimeError(f'missing attachment bone {bone}')

# Runtime timing matches ActorClip. The source motion is resampled, never
# decimated: triangle count, UV seams and skin weights are preserved.
clips = [
    ('Idle', 'Idle', 2.0, 5, True),
    ('Walk', 'Walk', 1.0, 17, True),
    ('Run', 'Walk', 0.667, 17, True),
    ('Fire', 'Cast', 0.333, 11, False),
    ('Reload', 'Water', 2.0, 15, False),
    ('Hit', 'Idle', 0.333, 7, False),
    ('Death', 'Idle', 1.25, 21, False),
]

def set_pose(source, phase):
    action = bpy.data.actions[source]
    rig.animation_data.action = action
    rig.animation_data.action_slot = action.slots[0]
    start, end = action.frame_range
    f = start + (end - start) * phase
    scene.frame_set(math.floor(f), subframe=f % 1.0)
    bpy.context.view_layer.update()

set_pose('Idle', 0.0)
# Coordinate conversion: Blender Z up / -Y forward -> game Y up / -Z forward.
# The importer restores the GLB basis in each object's world matrix.
def point(p):
    return Vector((-p.x, p.z, p.y))

rest = [point(o.matrix_world @ v.co) for o in meshes for v in o.data.vertices]
low = min(p.y for p in rest)
height = max(p.y for p in rest) - low
if not .3 < height < 4:
    raise RuntimeError(f'unexpected source height {height} m')
scale = 70.0 / height

def game_point(p):
    p = point(p)
    p.y -= low
    return p * scale

# Keep one opaque atlas. Export actual RGBA texels, rather than sampling the
# face/eye texture into coarse vertex colors.
images = set()
for o in meshes:
    for material in o.data.materials:
        if material and material.use_nodes:
            images.update(n.image for n in material.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
if len(images) != 1:
    raise RuntimeError(f'expected one atlas, found {len(images)}')
image = next(iter(images))
w, h = image.size
if w != h or w not in [16, 32, 64, 128, 256]:
    raise RuntimeError(f'atlas must be square power-of-two <= 256, got {w}x{h}')
pixels = list(image.pixels)
# Blender image pixels and mesh UVs both use the bottom-left origin. Store
# rows in that order and retain the UVs so the two stay consistent.
source_bytes = args.source.read_bytes()
json_length = struct.unpack_from('<I', source_bytes, 12)[0]
gltf = json.loads(source_bytes[20:20 + json_length])
if any(m.get('alphaMode', 'OPAQUE') != 'OPAQUE' for m in gltf.get('materials', [])):
    raise RuntimeError('this character path requires opaque source materials')
# glTF OPAQUE materials ignore atlas alpha, including unused transparent cells.
texture = bytes(255 if i % 4 == 3 else max(0, min(255, round(c * 255)))
                for i, c in enumerate(pixels))

vertices = []
indices = []
uvs = []
colors = []
light = Vector((-.4, .7, .6)).normalized()
for obj in meshes:
    mesh = obj.data
    mesh.calc_loop_triangles()
    if mesh.uv_layers.active is None:
        raise RuntimeError(f'{obj.name}: missing UV coordinates')
    seen = {}
    for triangle in mesh.loop_triangles:
        for loop_index in triangle.loops:
            vi = mesh.loops[loop_index].vertex_index
            uv = mesh.uv_layers.active.data[loop_index].uv
            quant_uv = tuple(round(c * 32768) for c in uv)
            if any(c < 0 or c > 65535 for c in quant_uv):
                raise RuntimeError('UV outside the unsigned GE range [0, 2)')
            key = (vi, quant_uv)
            if key not in seen:
                seen[key] = len(vertices)
                vertices.append((obj, vi))
                uvs.append(quant_uv)
                n = point(obj.matrix_world.to_3x3() @ mesh.vertices[vi].normal).normalized()
                shade = min(255, round((.78 + .22 * max(0.0, n.dot(light))) * 255))
                colors.append(bytes([shade, shade, shade, 255]))
            indices.append(seen[key])
if len(vertices) > 16000 or len(indices) > 32766:
    raise RuntimeError('character exceeds u16 draw/index budget')

# Sample all mesh vertices once per pose. Hit/Death use the same shared root
# transform for meshes and socket; the final fall is grounded before baking.
def sample(name, source, phase):
    source_phase = phase
    if name == 'Fire':
        source_phase = .42 + .58 * phase
    elif name in ['Hit', 'Death']:
        source_phase = 0.0
    set_pose(source, source_phase)
    graph = bpy.context.evaluated_depsgraph_get()
    posed = {}
    for obj in meshes:
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        if len(mesh.vertices) != len(obj.data.vertices):
            raise RuntimeError('topology changes between animation frames')
        posed[obj.name] = [game_point(evaluated.matrix_world @ v.co) for v in mesh.vertices]
        evaluated.to_mesh_clear()
    pts = [posed[obj.name][vi] for obj, vi in vertices]
    socket = game_point(rig.matrix_world @ rig.pose.bones[args.socket].head)
    if name == 'Hit':
        angle = -.13 * math.sin(phase * math.pi)
        center = Vector((0, 38, 0))
        rotation = Matrix.Rotation(angle, 3, 'X')
        pts = [center + rotation @ (p - center) for p in pts]
        socket = center + rotation @ (socket - center)
    elif name == 'Death':
        # A short recoil then an eased backward fall. Keep the last frame;
        # the runtime does not apply a second death transform.
        t = max(0.0, min(1.0, (phase - .08) / .82))
        t = t * t * (3.0 - 2.0 * t)
        rotation = Matrix.Rotation(t * math.pi / 2, 3, 'X')
        pts = [rotation @ p for p in pts]
        socket = rotation @ socket
    if name in ['Hit', 'Death']:
        # A dropped prop must not become the support point that leaves the
        # corpse floating. Ground the body and let the prop settle beside it.
        body = [p for p, (obj, _) in zip(pts, vertices) if obj.name != args.drop_mesh]
        lift = .01 - min(p.y for p in body)
        for p in pts:
            p.y += lift
        socket.y += lift
        if name == 'Death':
            attached = [i for i, (obj, _) in enumerate(vertices) if obj.name == args.drop_mesh]
            if attached:
                drop = max(0.0, min(1.0, (phase - .2) / .7))
                drop = drop * drop * (3.0 - 2.0 * drop)
                grip = rotation @ game_point(rig.matrix_world @ rig.pose.bones[args.grip].head)
                grip.y += lift
                axis = (socket - grip).normalized()
                original_axis = rotation.inverted() @ axis
                horizontal = Vector((original_axis.x, 0, original_axis.z)).normalized()
                if horizontal.length < .01:
                    horizontal = Vector((0, 0, 1))
                settle = Quaternion().slerp(axis.rotation_difference(horizontal), drop)
                for i in attached:
                    pts[i] = grip + settle @ (pts[i] - grip)
                prop_lift = .01 - min(pts[i].y for i in attached)
                prop_lift = max(prop_lift, prop_lift * drop)
                for i in attached:
                    pts[i].y += prop_lift
    return pts, socket

records = []
poses = bytearray()
sockets = bytearray()
all_poses = []
for name, source, duration, count, looping in clips:
    records.append((len(all_poses), count, duration, int(looping)))
    for frame in range(count):
        pts, socket = sample(name, source, frame / (count - 1))
        all_poses.append(pts)
        for p in pts:
            q = tuple(round(c * 256) for c in p)
            if any(abs(c) > 32767 for c in q):
                raise RuntimeError(f'{name}: vertex outside i16 coordinate budget')
            poses.extend(struct.pack('<3h', *q))
        sockets.extend(struct.pack('<3f', *socket))

# v2: 40-byte header, seven records, colors, u16 UVs, u16 indices,
# i16 XYZ frames, float XYZ attack sockets, then RGBA atlas bytes.
header = struct.pack('<4s9I', b'OPCH', 2, len(vertices), len(indices), len(clips),
                     len(all_poses), w, h, len(texture), 0)
blob = bytearray(header)
for record in records:
    blob.extend(struct.pack('<IIfI', *record))
blob.extend(b''.join(colors))
for uv in uvs:
    blob.extend(struct.pack('<2H', *uv))
blob.extend(struct.pack('<' + 'H' * len(indices), *indices))
blob.extend(poses)
blob.extend(sockets)
blob.extend(texture)
cache_bytes = len(all_poses) * len(vertices) * 32
if cache_bytes > 16 * 1024 * 1024:
    raise RuntimeError(f'morph cache exceeds 16 MiB: {cache_bytes}')
# Validate interpolated motion against Blender at actual simulation cadence.
qa = {}
for (name, source, duration, count, looping), record in zip(clips, records):
    worst = 0.0
    for tick in range(math.ceil(duration * 60) + 1):
        phase = min(1.0, tick / (duration * 60))
        exact, _ = sample(name, source, phase)
        f = phase * (count - 1)
        a = min(count - 1, int(f)); b = min(count - 1, a + 1); mix = f - a
        for i, p in enumerate(exact):
            interpolated = all_poses[record[0] + a][i].lerp(all_poses[record[0] + b][i], mix)
            worst = max(worst, (p - interpolated).length)
    qa[name] = round(worst, 4)
if max(qa.values()) > 2.0:
    raise RuntimeError(f'animation error exceeds 2 game units: {qa}')
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_bytes(blob)
receipt = dict(source_sha256=hashlib.sha256(args.source.read_bytes()).hexdigest(),
    triangles=len(indices)//3, vertices=len(vertices), source_height_m=height,
    baked_frames=len(all_poses), opch_bytes=len(blob), psp_morph_cache_bytes=cache_bytes,
    texture=[w,h], clips=[dict(name=c[0],source=c[1],duration=c[2],frames=c[3]) for c in clips],
    max_error_units_60hz=qa, opch_sha256=hashlib.sha256(blob).hexdigest())
args.output.with_suffix('.json').write_text(json.dumps(receipt, indent=2)+'\n')
print(json.dumps(receipt, indent=2))
