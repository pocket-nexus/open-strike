"""Author an editable low-poly crescent staff and its handheld viewmodel.

Blender --background --factory-startup --python scripts/build-staff.py --
  --output out/mods/frieren/staff

Geometry is authored here, not extracted from the character GLB. Coordinates
use OpenStrike's Y-up, -Z-forward viewmodel space. Generated art stays local.
"""
import argparse
import json
import math
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector, Matrix

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def material(name, color, metallic=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = 0.28 if metallic else 0.45
    return m


gold = material("Warm gold", (0.84, 0.57, 0.20), 0.75)
gold_light = material("Gold bevel", (1.0, 0.79, 0.38), 0.6)
wood = material("Lacquered crimson shaft", (0.39, 0.033, 0.052))
wrap = material("Crimson binding", (0.62, 0.028, 0.055))
gem = material("Ruby focus", (0.88, 0.018, 0.038), 0.2)
shine = material("Ruby highlight", (1.0, 0.43, 0.40))
objects = []


def finish(obj, name, mat):
    obj.name = name
    obj.data.materials.append(mat)
    objects.append(obj)
    return obj


def rod(name, a, b, radius, mat, sides=10, tip_radius=None):
    a, b = Vector(a), Vector(b)
    bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=radius,
                                    radius2=radius if tip_radius is None else tip_radius,
                                    depth=(b-a).length, location=(a+b)/2)
    obj = bpy.context.object
    obj.rotation_euler = (b-a).to_track_quat("Z", "Y").to_euler()
    return finish(obj, name, mat)


center = Vector((0, 12, -26))
rod("Staff shaft", (2.5, -35, 3), (0, 8.0, -25), 0.60, wood)
axis = Vector((-2.5, 43, -28)).normalized()
for y in [3.4, 4.6, 6.3, 7.5]:
    c = Vector((0, 8, -25)) - axis * (8-y)
    rod("Ferrule %.1f" % y, c-axis*0.35, c+axis*0.35, 0.86, gold_light)
rod("Grip", (1.66, -20.5, -6.4), (1.33, -14.7, -10.2), 0.69, wrap)
rod("Pommel", (2.5, -35, 3), (2.52, -36.3, 3.84), 0.82, gold)

# A tapered crescent with an open right side around the red focus.
verts, faces = [], []
segments, sides = 24, 6
for i in range(segments+1):
    t = i/segments
    angle = math.radians(55 + 280*t)
    radius = 4.0
    tube = 0.22 + 0.37 * math.sin(math.pi*t)
    for j in range(sides):
        p = 2*math.pi*j/sides
        r = radius + math.cos(p)*tube
        verts.append((center.x + math.cos(angle)*r,
                      center.y + math.sin(angle)*r,
                      center.z + math.sin(p)*tube))
for i in range(segments):
    for j in range(sides):
        a=i*sides+j; b=i*sides+(j+1)%sides
        faces.append((a,b,b+sides,a+sides))
faces += [tuple(range(sides-1,-1,-1)), tuple(segments*sides+j for j in range(sides))]
mesh=bpy.data.meshes.new("Crescent mesh");mesh.from_pydata(verts,[],faces);mesh.update()
obj=bpy.data.objects.new("Golden crescent",mesh);bpy.context.collection.objects.link(obj)
finish(obj,"Golden crescent",gold)
rod("Focus support", (0,7.6,-26), (0,10.0,-26), 0.5, gold)
bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=2.35, location=center)
finish(bpy.context.object,"Ruby focus",gem)
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.46,
                                    location=center+Vector((-0.8,0.8,2.0)))
finish(bpy.context.object,"Focus glint",shine)
rod("Red ribbon", (2.0,8.5,-25.9), (2.15,2.4,-25.7), 0.20, wrap, sides=4)
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.52, location=(2.15,1.9,-25.7))
bpy.context.object.scale=(0.55,1.7,0.45)
finish(bpy.context.object,"Ribbon pendant",gem)

# Export triangle colors with a fixed studio light baked into the vertex color.
# No texture, material parser, or lighting work runs on the handheld.
vertices=[]
light=Vector((-0.4,0.65,0.8)).normalized()
bpy.context.view_layer.update()
for obj in objects:
    obj.data.calc_loop_triangles()
    normal_matrix=obj.matrix_world.to_3x3().inverted().transposed()
    for tri in obj.data.loop_triangles:
        normal=(normal_matrix @ tri.normal).normalized()
        shade=0.62+0.38*max(0,normal.dot(light))
        rgba=obj.data.materials[tri.material_index].diffuse_color
        rgb=[min(255,round(255*(max(0,v)**(1/2.2))*shade)) for v in rgba[:3]]
        color=rgb[0] | rgb[1]<<8 | rgb[2]<<16 | 255<<24
        for index in tri.vertices:
            p=obj.matrix_world @ obj.data.vertices[index].co
            vertices.append((*p,color))
assert len(vertices) <= 3072 and len(vertices)%3==0
muzzle=(0.0,12.0,-29.3)
data=struct.pack("<4sII3f",b"OPVM",1,len(vertices),*muzzle)
data+=b"".join(struct.pack("<3fI",*v) for v in vertices)
output.with_suffix(".opvm").write_bytes(data)

# A source scene with named parts, a camera, and lighting for inspection.
bpy.ops.object.camera_add(location=(66,10,78))
camera=bpy.context.object
back=(camera.location-Vector((0,-8,-14))).normalized()
right=Vector((0,1,0)).cross(back).normalized()
up=back.cross(right)
camera.rotation_euler=Matrix((right,up,back)).transposed().to_euler()
camera.data.type="ORTHO";camera.data.ortho_scale=69
bpy.context.scene.camera=camera
for location,power,size in [((25,35,55),18000,35),((-25,10,25),9000,28)]:
    bpy.ops.object.light_add(type="AREA",location=location)
    lamp=bpy.context.object;lamp.data.energy=power;lamp.data.shape="DISK";lamp.data.size=size
    lamp.rotation_euler=(Vector((0,-5,-15))-lamp.location).to_track_quat("-Z","Y").to_euler()
scene=bpy.context.scene
scene.render.engine="CYCLES";scene.cycles.samples=32
scene.world.color=(0.12,0.12,0.12)
scene.render.resolution_x=640;scene.render.resolution_y=800;scene.render.resolution_percentage=100
scene.render.image_settings.file_format="PNG";scene.render.filepath=str(output.with_suffix(".png"))
bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix(".blend")))
bpy.ops.object.select_all(action="DESELECT")
for obj in objects:obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(output.with_suffix(".glb")),use_selection=True)
bpy.ops.render.render(write_still=True)
output.with_suffix(".json").write_text(json.dumps({"triangles":len(vertices)//3,
    "vertices":len(vertices),"muzzle":muzzle,"bytes":len(data)},indent=2)+"\n")
print("Staff exported:",len(vertices)//3,"triangles",output)
