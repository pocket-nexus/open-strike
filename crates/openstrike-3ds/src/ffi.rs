use crate::*;
pub unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, index: isize) -> i32 {
    if index as i32 >= argc {
        return 0;
    }
    let mut value = 0;
    JS_ToInt32(ctx, &mut value, *argv.offset(index));
    value
}
pub unsafe fn add_fn(
    ctx: *mut JSContext,
    object: JSValue,
    name: &'static [u8],
    function: unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
    args: i32,
) {
    let value = JS_NewCFunction2(
        ctx,
        Some(function),
        name.as_ptr().cast(),
        args,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, object, name.as_ptr().cast(), value);
}
