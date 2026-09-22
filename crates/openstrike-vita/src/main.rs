#[cfg(target_os = "vita")]
mod app;
#[cfg(target_os = "vita")]
mod presentation;
#[cfg(target_os = "vita")]
mod wired;
#[cfg(target_os = "vita")]
#[no_mangle]
#[used]
pub static sceUserMainThreadStackSize: u32 = 2 * 1024 * 1024;
#[cfg(target_os = "vita")]
fn main() {
    unsafe { wired::run() }
}
#[cfg(not(target_os = "vita"))]
fn main() {
    eprintln!("Use bun run build:vita for the native PS Vita application");
}
