/* Immutable indexed pose samples; PICA blends adjacent frames for every bot. */
#include "character_shbin.h"
#include "textured.h"
#include <string.h>
static DVLB_s *binary;
static shaderProgram_s program;
static int projection, weights;
static void *attributes, *poses;
static uint16_t *indices;
static size_t stride;
static uint32_t frame_count, index_count;
static C3D_Tex texture;
static bool textured;
int oschar_init(void) {
  binary = DVLB_ParseFile((u32 *)character_shbin, character_shbin_size);
  if (!binary)
    return 0;
  shaderProgramInit(&program);
  shaderProgramSetVsh(&program, &binary->DVLE[0]);
  projection =
      shaderInstanceGetUniformLocation(program.vertexShader, "projection");
  weights = shaderInstanceGetUniformLocation(program.vertexShader, "weights");
  return projection >= 0 && weights >= 0;
}
void oschar_clear(void) {
  if (attributes)
    linearFree(attributes);
  if (poses)
    linearFree(poses);
  if (indices)
    linearFree(indices);
  attributes = poses = NULL;
  indices = NULL;
  if (textured)
    C3D_TexDelete(&texture);
  textured = false;
  frame_count = index_count = 0;
}
void oschar_exit(void) {
  oschar_clear();
  if (binary) {
    shaderProgramFree(&program);
    DVLB_Free(binary);
    binary = NULL;
  }
}
int oschar_load(const void *attrs, const int16_t *samples, uint32_t nv,
                uint32_t nf, const uint16_t *idx, uint32_t ni,
                const uint8_t *rgba, uint32_t width) {
  oschar_clear();
  if (!nv || nv > 32767 || !nf || nf > 1024 || !ni || ni % 3)
    return 0;
  stride = (nv * 6 + 15) & ~15u;
  if (stride * nf > 8 * 1024 * 1024)
    return 0;
  attributes = linearAlloc(nv * 12);
  poses = linearAlloc(stride * nf);
  indices = linearAlloc(ni * 2);
  if (!attributes || !poses || !indices)
    goto failed;
  memcpy(attributes, attrs, nv * 12);
  memcpy(indices, idx, ni * 2);
  for (uint32_t f = 0; f < nf; f++)
    memcpy((uint8_t *)poses + f * stride, samples + f * nv * 3, nv * 6);
  GSPGPU_FlushDataCache(attributes, nv * 12);
  GSPGPU_FlushDataCache(indices, ni * 2);
  GSPGPU_FlushDataCache(poses, stride * nf);
  if (!p3d_texture_upload(&texture, rgba, width, width))
    goto failed;
  textured = true;
  frame_count = nf;
  index_count = ni;
  return 1;
failed:
  oschar_clear();
  return 0;
}
int oschar_draw(uint32_t a, uint32_t b, float mix, const C3D_Mtx *vp) {
  if (a >= frame_count || b >= frame_count)
    return 0;
  p3d_texture_begin(vp);
  C3D_BindProgram(&program);
  C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, projection, vp);
  C3D_FVUnifSet(GPU_VERTEX_SHADER, weights, 1.f - mix, mix, 0, 0);
  C3D_AttrInfo *attr = C3D_GetAttrInfo();
  AttrInfo_Init(attr);
  AttrInfo_AddLoader(attr, 0, GPU_FLOAT, 2);
  AttrInfo_AddLoader(attr, 1, GPU_UNSIGNED_BYTE, 4);
  AttrInfo_AddLoader(attr, 2, GPU_SHORT, 3);
  AttrInfo_AddLoader(attr, 3, GPU_SHORT, 3);
  C3D_BufInfo *buf = C3D_GetBufInfo();
  BufInfo_Init(buf);
  BufInfo_Add(buf, attributes, 12, 2, 0x10);
  BufInfo_Add(buf, (uint8_t *)poses + a * stride, 6, 1, 2);
  BufInfo_Add(buf, (uint8_t *)poses + b * stride, 6, 1, 3);
  C3D_TexBind(0, &texture);
  C3D_AlphaTest(true, GPU_GREATER, 127);
  C3D_DepthTest(true, GPU_GEQUAL, GPU_WRITE_ALL);
  C3D_DrawElements(GPU_TRIANGLES, index_count, C3D_UNSIGNED_SHORT, indices);
  return 1;
}
