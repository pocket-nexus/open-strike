"""Blender-side regression checks; writes generated fixtures under --out."""
import importlib.util
from pathlib import Path
import struct
import sys

import bpy

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('exporter', root / 'scripts/blender-to-map.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
out = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
mat = bpy.data.materials.new('fixture')
mat.diffuse_color = (.7, .5, .2, 1)
bpy.ops.mesh.primitive_cube_add(size=2, location=(2, 3, 4))
cube = bpy.context.object
cube.rotation_euler.z = .3
cube.scale = (-2, 1, .5)
cube.data.materials.append(mat)
materials = {}
text = exporter.brush(cube, 32, materials)
assert text.count('\n') == 7, text  # six distinct planes after a negative scale
exporter.export_scene(out / 'fixture.map')
wad = (out / 'fixture.wad').read_bytes()
assert wad[:4] == b'WAD3' and struct.unpack_from('<I', wad, 4)[0] == 1
assert '"mapversion" "220"' in (out / 'fixture.map').read_text()

# Visual-only brushes share one model and retain world coordinates.
cube['bsp_role'] = 'decor'
copy = cube.copy(); copy.data = cube.data.copy()
bpy.context.collection.objects.link(copy); copy.location.x += 5
bpy.context.scene['bsp_pocket_sky_zenith'] = '0.3 0.5 0.8'
bpy.context.scene['bsp_pocket_sky_horizon'] = '0.8 0.9 1'
exporter.export_scene(out / 'decor.map')
decor = (out / 'decor.map').read_text()
assert decor.count('"classname" "func_illusionary"') == 1
assert '"origin"' not in decor, 'world-space decor must not be translated twice'
assert '"pocket_sky_zenith" "0.3 0.5 0.8"' in decor
copy['bsp_role'] = 'solid'
exporter.export_scene(out / 'solid.map')
solid = (out / 'solid.map').read_text()
assert solid.count('"classname" "func_wall"') == 1
assert solid.count('"classname" "func_illusionary"') == 1
assert '"origin"' not in solid
bpy.data.objects.remove(copy, do_unlink=True)

bpy.ops.mesh.primitive_plane_add()
plane = bpy.context.object
plane.data.materials.append(mat)
try:
    exporter.brush(plane, 32, {})
    raise AssertionError('open mesh was accepted')
except ValueError as error:
    assert 'closed manifold' in str(error)
bpy.data.objects.remove(plane, do_unlink=True)
cube.data.vertices[0].co = (0, 0, 0)
try:
    exporter.brush(cube, 32, {})
    raise AssertionError('dented mesh was accepted')
except ValueError as error:
    assert 'non-planar' in str(error) or 'non-convex' in str(error)

pixels = [(255, 255, 255, 0)] * 4096
pixels[0] = (200, 210, 220, 255)
block = exporter.miptex('{fixture', pixels)
offsets = struct.unpack_from('<4I', block, 24)
assert block[offsets[0]] != 255 and block[offsets[0] + 1] == 255
assert block[offsets[2]] == 255, 'distant glass must not become opaque from point sampling'
print('BLENDER_MAP_FIXTURES_OK')
