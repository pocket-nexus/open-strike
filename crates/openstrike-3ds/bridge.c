#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include "quickjs.h"
#include "extension.h"
extern int os3ds_boot(void *);
extern int os3ds_tick(uint32_t,uint32_t,uint32_t);
extern int os3ds_after(void);
extern int os3ds_prepare(void);
extern int os3ds_render(uint32_t);
extern void os3ds_shutdown(void);
extern void os3ds_stats(float *);
bool pocket_extension_boot(void *ctx) {
#ifdef POCKETJS_CAPTURE
  FILE *f=fopen("sdmc:/pocketjs-captures/extension.txt","a");if(f){fputs("boot begin\n",f);fclose(f);}
#endif
  bool ok=os3ds_boot(ctx)!=0;
#ifdef POCKETJS_CAPTURE
  f=fopen("sdmc:/pocketjs-captures/extension.txt","a");if(f){fprintf(f,"boot end %d\n",ok);fclose(f);}
#endif
  return ok;
}
bool pocket_extension_tick(uint32_t b,uint32_t l,uint32_t r) {
  bool ok=os3ds_tick(b,l,r)!=0;
#ifdef POCKETJS_CAPTURE
  float stats[15];os3ds_stats(stats);
  if ((unsigned)stats[0]%5==0) {
    FILE *f=fopen("sdmc:/pocketjs-captures/scene.tsv","a");
    if(f){for(unsigned i=0;i<15;i++)fprintf(f,"%s%.3f",i?"\t":"",stats[i]);fputc('\n',f);fclose(f);}
  }
#endif
  return ok;
}
bool pocket_extension_after_guest(void) { return os3ds_after()!=0; }
bool pocket_extension_prepare(void) { return os3ds_prepare()!=0; }
bool pocket_extension_render(uint32_t surface) { return os3ds_render(surface)!=0; }
void pocket_extension_shutdown(void) { os3ds_shutdown(); }
/* Keep Rust declarations independent of generated PSP bindings. These wrap
 * only official QuickJS inline functions under the host's identical ABI. */
_Static_assert(sizeof(JSValue)==16,"QuickJS JS_NO_NAN_BOXING ABI");
int JS_ValueGetTag_real(JSValue v) { return JS_VALUE_GET_TAG(v); }
void JS_FreeValue_real(JSContext *c,JSValue v) { JS_FreeValue(c,v); }
JSValue JS_NewBool_real(JSContext *c,int v) { return JS_NewBool(c,v); }
JSValue JS_NewInt32_real(JSContext *c,int v) { return JS_NewInt32(c,v); }
JSValue JS_NewFloat64_real(JSContext *c,double v) { return JS_NewFloat64(c,v); }
int JS_IsUndefined_real(JSValue v) { return JS_IsUndefined(v); }
int JS_SetProperty_real(JSContext *c, JSValue o, JSAtom a, JSValue v) { return JS_SetProperty(c,o,a,v); }
