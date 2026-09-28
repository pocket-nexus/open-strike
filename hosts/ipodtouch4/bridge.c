#include "quickjs.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

/* Match the existing Rust QuickJS declarations using the pinned C headers. */
int JS_ValueGetTag_real(JSValue v) { return JS_VALUE_GET_TAG(v); }
void JS_FreeValue_real(JSContext *c, JSValue v) { JS_FreeValue(c, v); }
JSValue JS_NewBool_real(JSContext *c, int v) { return JS_NewBool(c, v); }
JSValue JS_NewInt32_real(JSContext *c, int32_t v) { return JS_NewInt32(c, v); }
JSValue JS_NewFloat64_real(JSContext *c, double v) { return JS_NewFloat64(c, v); }
int JS_IsUndefined_real(JSValue v) { return JS_IsUndefined(v); }
int JS_SetProperty_real(JSContext *c, JSValue o, JSAtom a, JSValue v) { return JS_SetProperty(c, o, a, v); }

extern uint64_t mach_absolute_time(void);
extern int mach_timebase_info(void *info);
uint64_t openstrike_now_us(void) {
    static struct { uint32_t numer, denom; } timebase;
    if (!timebase.denom) mach_timebase_info(&timebase);
    return (uint64_t)((double)mach_absolute_time() * timebase.numer / timebase.denom / 1000.0);
}

extern void *objc_getClass(const char *);
extern void *sel_registerName(const char *);
extern void *objc_msgSend(void);
/* Resolve resources in the iOS-owned application container, never a fixed UUID. */
FILE *openstrike_open_map(const char *name) {
    void *bundle = ((void *(*)(void *, void *))objc_msgSend)(objc_getClass("NSBundle"), sel_registerName("mainBundle"));
    void *resource = ((void *(*)(void *, void *))objc_msgSend)(bundle, sel_registerName("resourcePath"));
    const char *root = ((const char *(*)(void *, void *))objc_msgSend)(resource, sel_registerName("UTF8String"));
    char path[4096];
    if (!root || snprintf(path, sizeof path, "%s/maps/%s.p3d", root, name) >= (int)sizeof path) return NULL;
    return fopen(path, "rb");
}

extern void *NSTemporaryDirectory(void);
void openstrike_write_status(const char *text, size_t length) {
    const char *root = ((const char *(*)(void *, void *))objc_msgSend)(NSTemporaryDirectory(), sel_registerName("UTF8String"));
    char path[4096];
    if (!root || snprintf(path,sizeof path,"%sopenstrike-game.json",root) >= (int)sizeof path) return;
    FILE *file = fopen(path,"wb");
    if (file) { fwrite(text,1,length,file); fclose(file); }
}
