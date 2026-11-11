#include "textured.h"
#include <string.h>
static DVLB_s *binary;
static shaderProgram_s program;
static int projection;
_Static_assert(sizeof(P3D_TextureVertex) == 20, "quantized vertex ABI");
bool p3d_texture_init(const void *shader, size_t size) {
  binary = DVLB_ParseFile((u32 *)shader, size);
  if (!binary) return false;
  shaderProgramInit(&program);
  shaderProgramSetVsh(&program, &binary->DVLE[0]);
  projection = shaderInstanceGetUniformLocation(program.vertexShader, "projection");
  return projection >= 0;
}
void p3d_texture_exit(void) {
  if (binary) { shaderProgramFree(&program); DVLB_Free(binary); binary = NULL; }
}
void p3d_texture_mesh_free(P3D_TextureMesh *m) {
  if (m->vertices) linearFree(m->vertices);
  if (m->indices) linearFree(m->indices);
  memset(m, 0, sizeof *m);
}
bool p3d_texture_mesh_create(P3D_TextureMesh *m, const void *v, uint32_t nv, const uint16_t *idx, uint32_t ni) {
  memset(m, 0, sizeof *m);
  if (!v || !idx || !nv || nv > 1000000 || !ni || ni > 3000000 || ni % 3) return false;
  m->vertices = linearAlloc(nv * sizeof(P3D_TextureVertex));
  m->indices = linearAlloc(ni * sizeof *idx);
  if (!m->vertices || !m->indices) { p3d_texture_mesh_free(m); return false; }
  memcpy(m->vertices, v, nv * sizeof(P3D_TextureVertex));
  memcpy(m->indices, idx, ni * sizeof *idx);
  m->vertex_count = nv; m->index_count = ni;
  GSPGPU_FlushDataCache(m->vertices, nv * sizeof(P3D_TextureVertex));
  GSPGPU_FlushDataCache(m->indices, ni * sizeof *idx);
  return true;
}
static unsigned morton(unsigned x, unsigned y) {
  return (x & 1) | ((y & 1) << 1) | ((x & 2) << 1) | ((y & 2) << 2) | ((x & 4) << 2) | ((y & 4) << 3);
}
bool p3d_texture_upload(C3D_Tex *tex, const uint8_t *rgba, uint32_t w, uint32_t h) {
  if (!rgba || w < 8 || h < 8 || w > 1024 || h > 1024 || (w & (w - 1)) || (h & (h - 1))) return false;
  if (!C3D_TexInit(tex, w, h, GPU_RGBA8)) return false;
  uint8_t *dst = tex->data;
  for (unsigned y = 0; y < h; y++) for (unsigned x = 0; x < w; x++) {
    const uint8_t *src = rgba + ((h - 1 - y) * w + x) * 4;
    unsigned i = (((y / 8) * (w / 8) + x / 8) * 64 + morton(x & 7, y & 7)) * 4;
    dst[i] = src[3]; dst[i+1] = src[2]; dst[i+2] = src[1]; dst[i+3] = src[0];
  }
  GSPGPU_FlushDataCache(tex->data, tex->size);
  C3D_TexSetFilter(tex, GPU_LINEAR, GPU_LINEAR);
  C3D_TexSetWrap(tex, GPU_REPEAT, GPU_REPEAT);
  return true;
}
void p3d_texture_begin(const C3D_Mtx *vp) {
  p3d_begin(vp);
  C3D_BindProgram(&program);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection, vp);
  C3D_AttrInfo *a = C3D_GetAttrInfo();
  AttrInfo_Init(a);
  AttrInfo_AddLoader(a, 0, GPU_FLOAT, 2);
  AttrInfo_AddLoader(a, 1, GPU_UNSIGNED_BYTE, 4);
  AttrInfo_AddLoader(a, 2, GPU_SHORT, 3);
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvSrc(env, C3D_Both, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
  C3D_TexEnvFunc(env, C3D_Both, GPU_MODULATE);
}
bool p3d_texture_draw(const P3D_TextureMesh *m, C3D_Tex *tex, uint32_t base, uint32_t first, uint32_t n, bool masked, bool blended) {
  if (!tex || base >= m->vertex_count || first > m->index_count || n > m->index_count-first || n % 3) return false;
  C3D_BufInfo *b = C3D_GetBufInfo();
  BufInfo_Init(b);
  BufInfo_Add(b, (uint8_t *)m->vertices + base * sizeof(P3D_TextureVertex), sizeof(P3D_TextureVertex), 3, 0x210);
  C3D_TexBind(0, tex);
  C3D_AlphaTest(masked, GPU_GREATER, 127);
  C3D_DepthTest(true, GPU_GEQUAL, blended ? GPU_WRITE_COLOR : GPU_WRITE_ALL);
  C3D_DrawElements(GPU_TRIANGLES, n, C3D_UNSIGNED_SHORT, m->indices + first);
  return true;
}
