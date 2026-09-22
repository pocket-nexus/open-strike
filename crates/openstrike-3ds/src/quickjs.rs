//! QuickJS with JS_NO_NAN_BOXING: 16-byte tagged values, shared with the C host.
#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals)]

use core::ffi::{c_char, c_int};

pub type size_t = usize;
pub type JSAtom = u32;
#[repr(C)]
#[derive(Clone, Copy)]
pub union JSValueUnion {
    pub int32: i32,
    pub float64: f64,
    pub ptr: *mut core::ffi::c_void,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct JSValue {
    pub u: JSValueUnion,
    pub tag: i64,
}
pub type JSCFunctionEnum = u32;

#[repr(C)]
pub struct JSContext {
    _unused: [u8; 0],
}

pub type JSCFunction = Option<
    unsafe extern "C" fn(
        context: *mut JSContext,
        this_value: JSValue,
        argc: c_int,
        argv: *mut JSValue,
    ) -> JSValue,
>;

pub const JS_CFUNC_generic: JSCFunctionEnum = 0;
pub const JS_TAG_UNDEFINED: i32 = 3;
pub const JS_TAG_EXCEPTION: i32 = 6;
pub const JS_UNDEFINED: JSValue = JSValue {
    u: JSValueUnion { int32: 0 },
    tag: JS_TAG_UNDEFINED as i64,
};

const _: () = assert!(core::mem::size_of::<JSValue>() == 16);
const _: () = assert!(core::mem::align_of::<JSValue>() <= 8);

extern "C" {
    fn JS_SetProperty_real(
        context: *mut JSContext,
        object: JSValue,
        atom: JSAtom,
        value: JSValue,
    ) -> c_int;
    fn JS_ValueGetTag_real(value: JSValue) -> c_int;
    fn JS_FreeValue_real(context: *mut JSContext, value: JSValue);
    fn JS_NewBool_real(context: *mut JSContext, value: c_int) -> JSValue;
    fn JS_NewInt32_real(context: *mut JSContext, value: i32) -> JSValue;
    fn JS_NewFloat64_real(context: *mut JSContext, value: f64) -> JSValue;
    fn JS_IsUndefined_real(value: JSValue) -> c_int;

    pub fn JS_GetGlobalObject(context: *mut JSContext) -> JSValue;
    pub fn JS_NewObject(context: *mut JSContext) -> JSValue;
    pub fn JS_GetPropertyStr(
        context: *mut JSContext,
        object: JSValue,
        property: *const c_char,
    ) -> JSValue;
    pub fn JS_SetPropertyStr(
        context: *mut JSContext,
        object: JSValue,
        property: *const c_char,
        value: JSValue,
    ) -> c_int;
    pub fn JS_NewCFunction2(
        context: *mut JSContext,
        function: JSCFunction,
        name: *const c_char,
        length: c_int,
        prototype: JSCFunctionEnum,
        magic: c_int,
    ) -> JSValue;
    pub fn JS_Call(
        context: *mut JSContext,
        function: JSValue,
        this_value: JSValue,
        argc: c_int,
        argv: *mut JSValue,
    ) -> JSValue;
    pub fn JS_ToInt32(context: *mut JSContext, result: *mut i32, value: JSValue) -> c_int;
    pub fn JS_ToFloat64(context: *mut JSContext, result: *mut f64, value: JSValue) -> c_int;
    pub fn JS_ToCStringLen2(
        context: *mut JSContext,
        length: *mut size_t,
        value: JSValue,
        cesu8: c_int,
    ) -> *const c_char;
    pub fn JS_FreeCString(context: *mut JSContext, value: *const c_char);
}

pub unsafe fn JS_SetProperty(
    context: *mut JSContext,
    object: JSValue,
    atom: JSAtom,
    value: JSValue,
) -> c_int {
    JS_SetProperty_real(context, object, atom, value)
}

#[inline]
pub unsafe fn JS_ValueGetTag(value: JSValue) -> i32 {
    JS_ValueGetTag_real(value)
}

#[inline]
pub unsafe fn JS_FreeValue(context: *mut JSContext, value: JSValue) {
    JS_FreeValue_real(context, value)
}

#[inline]
pub unsafe fn JS_NewBool(context: *mut JSContext, value: bool) -> JSValue {
    JS_NewBool_real(context, i32::from(value))
}

#[inline]
pub unsafe fn JS_NewInt32(context: *mut JSContext, value: i32) -> JSValue {
    JS_NewInt32_real(context, value)
}

#[inline]
pub unsafe fn JS_NewFloat64(context: *mut JSContext, value: f64) -> JSValue {
    JS_NewFloat64_real(context, value)
}

#[inline]
pub unsafe fn JS_IsUndefined(value: JSValue) -> bool {
    JS_IsUndefined_real(value) != 0
}
