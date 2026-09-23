#![cfg_attr(target_os = "ios", no_std)]
#![allow(static_mut_refs)]
extern crate alloc;
pub mod input;

#[cfg(target_os = "ios")]
extern crate self as libquickjs_sys;
#[cfg(target_os = "ios")]
#[path = "../../openstrike-symbian/src/quickjs.rs"]
mod quickjs;
#[cfg(target_os = "ios")]
pub use quickjs::*;
#[cfg(target_os = "ios")]
mod actors;
#[cfg(target_os = "ios")]
mod app;
#[cfg(target_os = "ios")]
mod gl;
#[cfg(target_os = "ios")]
#[allow(dead_code)]
#[path = "../../openstrike-vita/src/present_data.rs"]
mod present_data;
#[cfg(target_os = "ios")]
#[path = "../../openstrike-vita/src/sim_boot.rs"]
mod sim_boot;
#[cfg(target_os = "ios")]
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../openstrike-psp/src/strike.rs"]
mod strike;
#[cfg(target_os = "ios")]
mod world;

#[cfg(target_os = "ios")]
mod ffi {
    use super::*;
    pub unsafe fn arg_i32(c: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
        let mut n = 0;
        if i < argc as isize {
            JS_ToInt32(c, &mut n, *argv.offset(i));
        }
        n
    }
    pub unsafe fn add_fn(
        c: *mut JSContext,
        o: JSValue,
        name: &'static [u8],
        f: unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
        args: i32,
    ) {
        let v = JS_NewCFunction2(c, Some(f), name.as_ptr().cast(), args, JS_CFUNC_generic, 0);
        JS_SetPropertyStr(c, o, name.as_ptr().cast(), v);
    }
}
