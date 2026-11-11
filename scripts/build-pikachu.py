"""Author a local Pikachu-inspired character, Poké Ball and seven editable actions.
Blender --background --factory-startup --python-exit-code 1 --python
scripts/build-pikachu.py -- --output out/mods/pikachu
No downloaded meshes, rigs or textures are used. Generated files stay local.
"""
import argparse, hashlib, json, math, struct, sys
from pathlib import Path
import bpy
from mathutils import Vector, Matrix
p=argparse.ArgumentParser();p.add_argument('--output',required=True)
out=Path(p.parse_args(sys.argv[sys.argv.index('--')+1:]).output).resolve();out.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version=0
scene=bpy.context.scene;scene.render.fps=24
palette={'yellow':(1,.72,.035),'black':(.018,.018,.025),'red':(.90,.035,.05),'white':(.96,.96,.90),'brown':(.34,.16,.035),'pink':(.91,.32,.43)}
materials={}
for name,c in palette.items():
 m=bpy.data.materials.new(name);m.diffuse_color=(*c,1);m.use_nodes=True;m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(*c,1);m.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.7;materials[name]=m
parts=[]
def finish(obj,name,color,bone):
 obj.name=name;obj.data.materials.append(materials[color]);obj['bone']=bone;parts.append(obj);return obj

def sphere(name,center,scale,color,bone,segments=16,rings=8):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings,radius=1,location=center)
 o=finish(bpy.context.object,name,color,bone);o.scale=scale;return o

def tube(name,a,b,r,color,bone,sides=8):
 a,b=Vector(a),Vector(b);bpy.ops.mesh.primitive_cone_add(vertices=sides,radius1=r,radius2=r,depth=(b-a).length,location=(a+b)/2)
 o=finish(bpy.context.object,name,color,bone);o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler();return o

def custom(name,verts,faces,color,bone):
 m=bpy.data.meshes.new(name);m.from_pydata(verts,[],faces);m.update();o=bpy.data.objects.new(name,m);scene.collection.objects.link(o);return finish(o,name,color,bone)

def ball(center,radius,bone,prefix):
 # Red north shell, white south shell, an opaque black equator and front button.
 c=Vector(center);levels=[(-1,'white'),(-.87,'white'),(-.5,'white'),(-.065,'white'),(.065,'black'),(.5,'red'),(.87,'red'),(1,'red')]
 for j in range(len(levels)-1):
  lo,_=levels[j];hi,col=levels[j+1]
  verts=[]
  for z in [lo,hi]:
   rr=math.sqrt(max(0,1-z*z))
   verts.extend([tuple(c+radius*Vector((rr*math.cos(i*math.tau/16),rr*math.sin(i*math.tau/16),z))) for i in range(16)])
  custom(prefix+' shell '+str(j),verts,[(i,(i+1)%16,(i+1)%16+16,i+16) for i in range(16)],col,bone)
 sphere(prefix+' button rim',c+Vector((0,radius*.997,0)),(radius*.28,radius*.085,radius*.28),'black',bone,12,6)
 sphere(prefix+' button',c+Vector((0,radius*1.06,0)),(radius*.18,radius*.055,radius*.18),'white',bone,12,6)

sphere('Round belly',(0,0,.64),(.355,.28,.51),'yellow','body')
sphere('Cheeky head',(0,.015,1.20),(.43,.305,.34),'yellow','head',20,10)
for side,s in [('L',-1),('R',1)]:
 sphere('Foot '+side,(s*.22,.12,.10),(.16,.24,.10),'yellow','foot.'+side,12,6)
 sphere('Arm '+side,(s*.36,.11,.80),(.105,.12,.255),'yellow','arm.'+side,12,6)
 sphere('Paw '+side,(s*.39,.20,.64),(.115,.105,.105),'yellow','arm.'+side,12,6)
 sphere('Eye '+side,(s*.16,.285,1.285),(.077,.038,.089),'black','head',12,6)
 sphere('Eye highlight '+side,(s*.174,.319,1.315),(.027,.014,.032),'white','head',8,4)
 sphere('Cheek '+side,(s*.325,.233,1.13),(.095,.048,.096),'red','head',12,6)
 start=Vector((s*.24,0,1.39));end=Vector((s*(.48 if s<0 else .77),-.015,1.98 if s<0 else 1.76));axis=(end-start).normalized()
 u=Vector((axis.z,0,-axis.x));v=Vector((0,1,0))
 levels=[(0,.075),(.23,.102),(.66,.072),(.74,.061),(1,.003)]
 for k in range(len(levels)-1):
  verts=[]
  for t,r in levels[k:k+2]:
   verts.extend([tuple(start+(end-start)*t+u*r*math.cos(i*math.tau/8)+v*r*.55*math.sin(i*math.tau/8)) for i in range(8)])
  custom('Ear '+side+str(k),verts,[(i,(i+1)%8,(i+1)%8+8,i+8) for i in range(8)],'black' if k==3 else 'yellow','ear.'+side)
custom('Nose',[(-.03,.324,1.20),(.03,.324,1.20),(0,.344,1.178)],[(0,2,1)],'black','head')
for a,b in [((-.075,.316,1.124),(-.038,.330,1.100)),((-.038,.330,1.100),(0,.334,1.125)),((0,.334,1.125),(.038,.330,1.100)),((.038,.330,1.100),(.075,.316,1.124))]:tube('Smile',a,b,.010,'black','head',6)
# Back stripes and broad lightning-bolt tail, visible from side and rear.
for z in [.64,.82]:sphere('Back stripe',(0,-.265,z),(.29,.026,.060),'brown','body',12,6)
outline=[(.16,.43),(.39,.66),(.28,.85),(.54,1.05),(.43,1.23),(.76,1.53),(.96,1.28),(.65,1.03),(.74,.84),(.46,.68),(.54,.51),(.23,.34)]
verts=[(x,y,z) for y in [-.27,-.35] for x,z in outline];n=len(outline)
custom('Lightning tail',verts,[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],'yellow','tail')
tube('Brown tail root',(.12,-.29,.39),(.30,-.29,.51),.053,'brown','tail')
ball((.40,.245,.69),.13,'ball','Held ball')
bpy.context.view_layer.update()
# Join into one indexed skinned mesh, retaining material assignments and rigid weights.
verts=[];faces=[];colors=[];groups=[]
for o in parts:
 offset=len(verts);verts.extend([tuple(o.matrix_world@v.co) for v in o.data.vertices]);groups.extend([o['bone']]*len(o.data.vertices))
 colors.extend([tuple(o.data.materials[0].diffuse_color[:3])]*len(o.data.vertices));faces.extend([tuple(offset+i for i in poly.vertices) for poly in o.data.polygons])
mesh=bpy.data.meshes.new('Pikachu mesh');mesh.from_pydata(verts,[],faces);mesh.update()
obj=bpy.data.objects.new('Pikachu',mesh);scene.collection.objects.link(obj)
for m in materials.values():mesh.materials.append(m)
for poly in mesh.polygons:
 c=colors[poly.vertices[0]];poly.material_index=list(palette.values()).index(c) if c in palette.values() else min(range(len(palette)),key=lambda i:sum((list(palette.values())[i][j]-c[j])**2 for j in range(3)))
for o in parts:bpy.data.objects.remove(o,do_unlink=True)
parts=[]
bones=[('root',(0,0,0),(0,0,.2),None),('body',(0,0,.43),(0,0,1.0),'root'),('head',(0,0,1.05),(0,0,1.37),'body'),('tail',(.12,-.29,.4),(.45,-.29,.8),'body')]
for side,s in [('L',-1),('R',1)]:
 bones += [('foot.'+side,(s*.22,0,.15),(s*.22,.2,.15),'root'),('arm.'+side,(s*.31,.03,.97),(s*.40,.22,.66),'body'),('ear.'+side,(s*.24,0,1.39),(s*.4,0,1.75),'head')]
bones.append(('ball',(.40,.245,.69),(.40,.345,.69),'arm.R'))
arm=bpy.data.armatures.new('Pikachu rig');rig=bpy.data.objects.new('Pikachu rig',arm);scene.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for name,head,tail,parent in bones:
 b=arm.edit_bones.new(name);b.head=head;b.tail=tail
 if parent:b.parent=arm.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT');rig.show_in_front=True
for name,*_ in bones:
 g=obj.vertex_groups.new(name=name);ids=[i for i,s in enumerate(groups) if s==name]
 if ids:g.add(ids,1,'REPLACE')
obj.parent=rig;mod=obj.modifiers.new('Skin','ARMATURE');mod.object=rig
clips=[('Idle',2.,True,6),('Walk',1.,True,16),('Run',.667,True,24),('Fire',.333,False,24),('Reload',2.,False,12),('Hit',.333,False,12),('Death',1.25,False,24)]
def smooth(t):t=max(0,min(1,t));return t*t*(3-2*t)
def pose(name,t,duration):
 for b in rig.pose.bones:b.rotation_mode='XYZ';b.rotation_euler=(0,0,0);b.location=(0,0,0);b.scale=(1,1,1)
 phase=t/duration*math.tau;wave=math.sin(phase)
 for side,s in [('L',-1),('R',1)]:rig.pose.bones['ear.'+side].rotation_euler[1]=s*.08*wave
 rig.pose.bones['tail'].rotation_euler[1]=.09*wave
 if name=='Idle':rig.pose.bones['body'].rotation_euler[0]=.025*wave;rig.pose.bones['head'].rotation_euler[2]=.035*wave
 elif name in ('Walk','Run'):
  swing=.52 if name=='Run' else .34
  for side,s in [('L',-1),('R',1)]:
   rig.pose.bones['foot.'+side].rotation_euler[0]=s*swing*wave
   rig.pose.bones['arm.'+side].rotation_euler[0]=-s*.45*wave
  rig.pose.bones['body'].rotation_euler[2]=.07*wave
 elif name=='Fire':
  rig.pose.bones['ball'].scale=(.001,.001,.001) if t>.035 else (1,1,1)
  a=math.sin(math.pi*t/duration);rig.pose.bones['arm.R'].rotation_euler[0]=-1.35*a;rig.pose.bones['body'].rotation_euler[2]=-.14*a;rig.pose.bones['head'].rotation_euler[0]=.1*a
 elif name=='Reload':
  a=math.sin(math.pi*t/duration);rig.pose.bones['arm.R'].rotation_euler[2]=-.75*a;rig.pose.bones['arm.L'].rotation_euler[2]=.75*a;rig.pose.bones['head'].rotation_euler[0]=.20*a
 elif name=='Hit':
  a=math.sin(math.pi*t/duration);rig.pose.bones['body'].rotation_euler[0]=-.22*a;rig.pose.bones['ear.L'].rotation_euler[1]=.35*a
 elif name=='Death':
  a=smooth(t/duration);rig.pose.bones['root'].rotation_euler[0]=-math.pi*.48*a;rig.pose.bones['arm.L'].rotation_euler[2]=.65*a;rig.pose.bones['arm.R'].rotation_euler[2]=-.7*a
 bpy.context.view_layer.update()
 # Place the support vertices on the ground, including the held final fall.
 support=range(len(verts)) if name=='Death' else [i for i,g in enumerate(groups) if g.startswith('foot.')]
 low=min((rig.pose.bones[groups[i]].matrix@arm.bones[groups[i]].matrix_local.inverted()@Vector(verts[i])).z for i in support)
 rig.pose.bones['root'].location.y-=low
rig.animation_data_create()
for name,duration,loop,hz in clips:
 action=bpy.data.actions.new(name);rig.animation_data.action=action
 for f in range(round(duration*24)+1):
  pose(name,duration*f/round(duration*24),duration)
  for b in rig.pose.bones:
   b.keyframe_insert('rotation_euler',frame=f+1,group=b.name);b.keyframe_insert('location',frame=f+1,group=b.name);b.keyframe_insert('scale',frame=f+1,group=b.name)
 action.use_fake_user=True
mesh.calc_loop_triangles();indices=[i for tri in mesh.loop_triangles for i in tri.vertices]
scale=70/1.98;records=[];frames=bytearray();sockets=bytearray();count=0
for name,duration,loop,hz in clips:
 rig.animation_data.action=bpy.data.actions[name];n=max(2,round(duration*hz)+1);records.append((count,n,duration,int(loop)))
 for k in range(n):
  f=1+duration*24*k/(n-1);scene.frame_set(math.floor(f),subframe=f%1)
  e=obj.evaluated_get(bpy.context.evaluated_depsgraph_get());em=e.to_mesh()
  for v in em.vertices:frames.extend(struct.pack('<3h',round(v.co.x*scale*256),round(v.co.z*scale*256),round(-v.co.y*scale*256)))
  e.to_mesh_clear()
  socket=rig.pose.bones['arm.R'].matrix@arm.bones['arm.R'].matrix_local.inverted()@Vector((.40,.245,.69))
  sockets.extend(struct.pack('<3f',socket.x*scale,socket.z*scale,-socket.y*scale))
 count+=n
# White atlas keeps the OPCH/2 socket contract; character color lives in vertices.
blob=bytearray(struct.pack('<4s9I',b'OPCH',2,len(verts),len(indices),7,count,16,16,1024,0))
for r in records:blob.extend(struct.pack('<IIfI',*r))
light=Vector((-.4,.7,.8)).normalized()
for i,c in enumerate(colors):
 shade=.78+.22*max(0,mesh.vertices[i].normal.dot(light));blob.extend(bytes([*[min(255,round(255*x*shade)) for x in c],255]))
blob.extend(bytes(len(verts)*4));blob.extend(struct.pack('<'+'H'*len(indices),*indices));blob.extend(frames);blob.extend(sockets);blob.extend(bytes([255])*1024)
assert count*len(verts)*32<=16*1024*1024
(out/'character.opch').write_bytes(blob)
rig.animation_data.action=bpy.data.actions['Idle'];scene.frame_set(1)
bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);rig.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(out/'pikachu.glb'),use_selection=True,export_animations=True,export_animation_mode='ACTIONS',export_skins=True)
# First-person ball cradled by two yellow paws. World mesh shares the same recipe.
def export_mesh(path,objects,transform,muzzle):
 bpy.context.view_layer.update();data=[]
 for o in objects:
  o.data.calc_loop_triangles();rgb=o.data.materials[0].diffuse_color
  for tri in o.data.loop_triangles:
   shade=.78+.22*max(0,(o.matrix_world.to_3x3()@tri.normal).normalized().dot(light))
   col=sum(min(255,round(255*rgb[i]*shade))<<(8*i) for i in range(3)) | 0xff000000
   for i in tri.vertices:
    v=transform(o.matrix_world@o.data.vertices[i].co);data.append((*v,col))
 assert len(data)<=3072
 path.write_bytes(struct.pack('<4sII3f',b'OPVM',1,len(data),*muzzle)+b''.join(struct.pack('<3fI',*v) for v in data));return len(data)//3
obj.hide_render=True;rig.hide_render=True;obj.hide_set(True);rig.hide_set(True)
parts=[];ball((0,0,0),1,'root','Projectile')
projectile_tris=export_mesh(out/'ball.opvm',parts,lambda v:(v.x,v.z,-v.y),(0,0,0))
bpy.ops.wm.save_as_mainfile(filepath=str(out/'pokeball.blend'))
for o in parts:bpy.data.objects.remove(o,do_unlink=True)
parts=[];ball((0,0,0),.125,'root','View ball')
sphere('Left paw',(-.092,.016,-.075),(.078,.066,.077),'yellow','root',12,6)
sphere('Right paw',(.092,.016,-.075),(.078,.066,.077),'yellow','root',12,6)
view_tris=export_mesh(out/'viewmodel.opvm',parts,lambda v:(-v.x*27,v.z*27+2,v.y*27-13),(0,2,-13))
bpy.ops.wm.save_as_mainfile(filepath=str(out/'viewmodel.blend'))
for o in parts:bpy.data.objects.remove(o,do_unlink=True)
obj.hide_render=False;rig.hide_render=False;obj.hide_set(False);rig.hide_set(False)
# Editable character studio source and front three-quarter preview.
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.view_settings.view_transform='Standard'
scene.world.color=(.20,.23,.30)
for pos,power in [((3,4,5),500),((-3,2,3),220),((1,-3,4),420)]:
 bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=power;o.data.shape='DISK';o.data.size=4;o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(2.4,5,2.0));cam=bpy.context.object;cam.rotation_euler=(Vector((.1,0,1))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=2.55;scene.camera=cam
scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100
bpy.ops.wm.save_as_mainfile(filepath=str(out/'pikachu.blend'));scene.render.filepath=str(out/'preview.png');bpy.ops.render.render(write_still=True)
receipt={'triangles':len(indices)//3,'vertices':len(verts),'poses':count,'cache_bytes':count*len(verts)*32,'character_bytes':len(blob),'opch_sha256':hashlib.sha256(blob).hexdigest(),'viewmodel_triangles':view_tris,'projectile_triangles':projectile_tris,'clips':[c[0] for c in clips]}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2));(out/'character.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
