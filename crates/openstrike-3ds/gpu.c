#include "pocket3d.h"
#include "textured.h"
#include "color_shbin.h"
#include "textured_shbin.h"
#include <stdlib.h>
#include <string.h>

typedef struct { uint32_t color; float x,y,z; } ColorVertex;
static P3D_TextureMesh world;
static C3D_Tex *textures;
static uint32_t texture_count, uploaded;
static P3D_Mesh dynamic;
static size_t used;
static C3D_Mtx view_projection;
static bool initialized;
#define DYNAMIC_VERTICES 65536

static C3D_Mtx matrix(const float *m) {
  C3D_Mtx result;
  for (unsigned r=0;r<4;r++) result.r[r]=FVec4_New(m[r],m[4+r],m[8+r],m[12+r]);
  return result;
}
int osgpu_init(void) {
  if (initialized) return 1;
  if (!p3d_init(color_shbin,color_shbin_size)) return 0;
  if (!p3d_texture_init(textured_shbin,textured_shbin_size) || !p3d_mesh_create(&dynamic,DYNAMIC_VERTICES)) {
    p3d_texture_exit();p3d_exit();return 0;
  }
  initialized=true; return 1;
}
void osgpu_clear_world(void) {
  p3d_texture_mesh_free(&world);
  for (unsigned i=0;i<uploaded;i++) C3D_TexDelete(&textures[i]);
  free(textures);textures=NULL;texture_count=uploaded=0;
}
void osgpu_shutdown(void) {
  if (!initialized) return;
  osgpu_clear_world();p3d_mesh_free(&dynamic);
  p3d_texture_exit();p3d_exit();
  initialized=false;
}
int osgpu_world(const uint8_t *v,uint32_t nv,const uint16_t *idx,uint32_t ni,uint32_t nt) {
  if (nt>4096 || !nt) return 0;
  if (!p3d_texture_mesh_create(&world,v,nv,idx,ni)) return 0;
  textures=calloc(nt,sizeof *textures);texture_count=nt;
  return textures!=NULL;
}
int osgpu_texture(uint32_t i,const uint8_t *rgba,uint32_t w,uint32_t h) {
  if (i!=uploaded || i>=texture_count) return 0;
  if (!p3d_texture_upload(&textures[i],rgba,w,h)) return 0;
  uploaded++;return 1;
}
void osgpu_begin(const float *view) {
  used=0;
  C3D_Mtx projection, v=matrix(view);
  Mtx_PerspTilt(&projection,74.f*3.14159265359f/180.f,400.f/240.f,4.f,8192.f,false);
  Mtx_Multiply(&view_projection,&projection,&v);
  // A camera-independent sky gradient fills unoccupied world pixels.
  C3D_Mtx sky;
  Mtx_OrthoTilt(&sky,-1,1,-1,1,-1,1,false);
  P3D_ColorVertex vertices[6]={
    {{-1,-1,0},{.93f,.79f,.62f,1}},{{1,-1,0},{.93f,.79f,.62f,1}},{{1,1,0},{.34f,.48f,.66f,1}},
    {{-1,-1,0},{.93f,.79f,.62f,1}},{{1,1,0},{.34f,.48f,.66f,1}},{{-1,1,0},{.34f,.48f,.66f,1}}};
  memcpy(dynamic.vertices,vertices,sizeof vertices);used=6;
  GSPGPU_FlushDataCache(dynamic.vertices,sizeof vertices);
  P3D_Mesh sky_mesh=dynamic;sky_mesh.count=6;
  p3d_begin(&sky);C3D_DepthTest(false,GPU_ALWAYS,GPU_WRITE_COLOR);p3d_draw(&sky_mesh);
}
void osgpu_world_begin(void) {p3d_texture_begin(&view_projection);}
int osgpu_run(uint32_t t,uint32_t base,uint32_t first,uint32_t n,int masked,int blended) {
  return t<uploaded && p3d_texture_draw(&world,&textures[t],base,first,n,masked,blended);
}
int osgpu_color(const ColorVertex *v,size_t n,const float *model,int mode) {
  if (!n) return 1;
  if (n%3 || n>DYNAMIC_VERTICES-used) return 0;
  P3D_ColorVertex *dst=dynamic.vertices+used;
  for (size_t i=0;i<n;i++) {
    dst[i]=(P3D_ColorVertex){{v[i].x,v[i].y,v[i].z},
      {(v[i].color&255)/255.f,((v[i].color>>8)&255)/255.f,((v[i].color>>16)&255)/255.f,(v[i].color>>24)/255.f}};
  }
  GSPGPU_FlushDataCache(dst,n*sizeof *dst);
  C3D_Mtx m=matrix(model),vp;
  Mtx_Multiply(&vp,&view_projection,&m);
  if (mode==2) {
    // Reserve the nearest 0.1% of clip depth for the rifle, preserving its
    // own depth ordering without a mid-frame framebuffer clear.
    vp.r[2]=FVec4_Subtract(FVec4_Scale(vp.r[2],.001f),FVec4_Scale(vp.r[3],.999f));
  }
  p3d_begin(&vp);
  if (mode==1) {
    C3D_AlphaBlend(GPU_BLEND_ADD,GPU_BLEND_ADD,GPU_SRC_ALPHA,GPU_ONE,GPU_ONE,GPU_ONE);
    C3D_DepthTest(true,GPU_GEQUAL,GPU_WRITE_COLOR);
  }
  P3D_Mesh mesh={.vertices=dst,.count=n,.capacity=n};
  BufInfo_Init(&mesh.buffer);BufInfo_Add(&mesh.buffer,dst,sizeof *dst,2,0x10);
  p3d_draw(&mesh);used+=n;return 1;
}
