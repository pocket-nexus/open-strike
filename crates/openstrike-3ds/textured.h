#ifndef POCKET3D_CITRO3D_TEXTURED_H
#define POCKET3D_CITRO3D_TEXTURED_H
#include "pocket3d.h"
/* Quantized triangle mesh. Indices are relative to the caller's vertex base.
 * UVs are normalized, color bytes RGBA, position is signed world units. */
typedef struct { float uv[2]; uint8_t color[4]; int16_t position[3]; uint16_t pad; } P3D_TextureVertex;
typedef struct { void *vertices; uint16_t *indices; uint32_t vertex_count, index_count; } P3D_TextureMesh;
bool p3d_texture_init(const void *shader, size_t size);
void p3d_texture_exit(void);
bool p3d_texture_mesh_create(P3D_TextureMesh *, const void *vertices, uint32_t vertex_count, const uint16_t *indices, uint32_t index_count);
void p3d_texture_mesh_free(P3D_TextureMesh *);
/* Power-of-two RGBA8 input, 8..1024 pixels. Uploads once into tiled GPU memory. */
bool p3d_texture_upload(C3D_Tex *, const uint8_t *rgba, uint32_t width, uint32_t height);
void p3d_texture_begin(const C3D_Mtx *view_projection);
bool p3d_texture_draw(const P3D_TextureMesh *, C3D_Tex *, uint32_t vertex_base, uint32_t first, uint32_t count, bool masked, bool blended);
#endif
