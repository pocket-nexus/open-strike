#ifndef POCKETJS_3DS_EXTENSION_H
#define POCKETJS_3DS_EXTENSION_H
#include <stdbool.h>
#include <stdint.h>
/* Optional native specialization. All callbacks run on the host thread.
 * boot precedes guest eval; shutdown precedes destruction of the JS context.
 * prepare/render/shutdown run after the previous GPU frame has retired.
 * prepare may replace GPU resources; render draws underneath each UI surface.
 * A false return enters the host's ordinary package recovery path.
 * No callback may retain borrowed input or submit its own C3D frame. */
bool pocket_extension_boot(void *context) __attribute__((weak));
bool pocket_extension_tick(uint32_t buttons, uint32_t analog, uint32_t right) __attribute__((weak));
bool pocket_extension_after_guest(void) __attribute__((weak));
bool pocket_extension_prepare(void) __attribute__((weak));
bool pocket_extension_render(uint32_t surface) __attribute__((weak));
void pocket_extension_shutdown(void) __attribute__((weak));
#endif
