//! Game-specific guest replacement at closed GXM boundaries. PocketJS owns
//! USB transport, admission, native slots, menu input and capture delivery.
use crate::app::App;
use openstrike_vita::input::PadSample;
use pocketjs_vita::{
    dev,
    dev_protocol::{Bundle, Op},
    devmenu::Action,
    graphics, input, switch, vita_log,
};
use std::sync::Arc;

struct Candidate {
    request: Option<dev::Request>,
    previous: Option<Arc<Bundle>>,
    hash: String,
}
unsafe fn now(frame: u32) -> u64 {
    #[cfg(feature = "capture")]
    {
        frame as u64 * 1_000_000 / 60 + 1
    }
    #[cfg(not(feature = "capture"))]
    {
        let _ = frame;
        vitasdk_sys::sceKernelGetProcessTimeWide()
    }
}
unsafe fn stop(app: &mut Option<App>) {
    if let Some(app) = app.take() {
        app.shutdown();
    }
}
unsafe fn recover(
    app: &mut Option<App>,
    active: &mut Option<Arc<Bundle>>,
    candidate: &mut Option<Candidate>,
    dev: &mut dev::Host,
    error: String,
    clock: u64,
) {
    stop(app);
    dev.error = error.clone();
    dev.menu.visible = true;
    if let Some(previous) = candidate.take() {
        *active = previous.previous;
        dev.active_hash = previous.hash;
        match App::boot(active, clock) {
            Ok(guest) => *app = Some(guest),
            Err(e) => dev.error = format!("{error}; restore failed: {e}"),
        }
        if let Some(request) = previous.request {
            request.finish(Err(dev.error.clone()));
        }
    }
}

pub unsafe fn run() {
    if let Err(error) = graphics::init_with_pool(8 * 1024 * 1024) {
        vita_log(format_args!("OpenStrike graphics: {error}"));
        return;
    }
    input::init();
    switch::set_current(0);
    let mut dev = dev::Host::new();
    let embedded_hash = dev.active_hash.clone();
    let output = switch::APPS[0].output;
    let mut active = None;
    let mut app = match App::boot(&active, now(0)) {
        Ok(a) => Some(a),
        Err(e) => {
            dev.error = e;
            dev.menu.visible = true;
            None
        }
    };
    let mut candidate: Option<Candidate> = None;
    let mut frame = 0u32;
    #[cfg(feature = "capture")]
    let script =
        openstrike_vita::capture::CaptureScript::parse(env!("OPENSTRIKE_VITA_CAPTURE_INPUT"));
    #[cfg(feature = "capture")]
    let cap_start = env!("OPENSTRIKE_VITA_CAP_START")
        .parse::<u32>()
        .unwrap_or(96);
    #[cfg(feature = "capture")]
    let cap_n = env!("OPENSTRIKE_VITA_CAP_N")
        .parse::<u32>()
        .unwrap_or(1)
        .max(1);
    loop {
        let raw = input::read();
        let sample = PadSample {
            buttons: raw.buttons,
            lx: raw.lx,
            ly: raw.ly,
            rx: raw.rx,
            ry: raw.ry,
        };
        #[cfg(feature = "capture")]
        let sample = script.sample(frame, sample);
        let (buttons, action) = dev.menu.input(sample.buttons);
        let sample = if dev.menu.visible {
            PadSample::default()
        } else {
            PadSample { buttons, ..sample }
        };
        let touches = if dev.menu.visible {
            input::TouchSnapshot::EMPTY
        } else {
            input::read_touches()
        };
        if let Some(guest) = app.as_mut() {
            if let Err(error) = guest.frame(sample, &touches, now(frame), dev.menu.visible) {
                recover(
                    &mut app,
                    &mut active,
                    &mut candidate,
                    &mut dev,
                    error,
                    now(frame),
                );
            }
        }
        let rendered = if let Some(guest) = app.as_mut() {
            guest.render()
        } else {
            graphics::begin_frame(0xff1c_1410);
            Ok(())
        };
        dev.overlay();
        graphics::present();
        let completed = rendered.and_then(|_| {
            if let Some(guest) = app.as_mut() {
                guest.after_present(now(frame))
            } else {
                Ok(())
            }
        });
        if let Err(error) = completed {
            recover(
                &mut app,
                &mut active,
                &mut candidate,
                &mut dev,
                error,
                now(frame),
            );
        }
        if app.is_some() {
            if let Some(accepted) = candidate.take() {
                vita2d_sys::vita2d_wait_rendering_done();
                dev.generation += 1;
                dev.error.clear();
                if let Some(request) = accepted.request {
                    request.finish(Ok(serde_json::json!({"generation":dev.generation,"bundle":dev.active_hash,"frame":frame,"nativeBuild":dev::NATIVE_BUILD})));
                }
            }
        }
        dev.publish(frame, output);
        #[cfg(feature = "bench")]
        if frame % 300 == 299 {
            if let Some(guest) = app.as_ref() {
                vita_log(format_args!("OpenStrike telemetry {}", guest.status()));
            }
        }
        #[cfg(feature = "capture")]
        {
            if !dev.error.is_empty() {
                let _ = std::fs::create_dir_all("ux0:data/openstrike-vita/cap");
                let _ = std::fs::write("ux0:data/openstrike-vita/cap/error.txt", &dev.error);
            }
            if frame >= cap_start && frame < cap_start.saturating_add(cap_n) {
                if let Some(guest) = app.as_mut() {
                    if let Err(e) = guest.capture(frame - cap_start) {
                        let _ = std::fs::write("ux0:data/openstrike-vita/cap/error.txt", e);
                    }
                }
                if frame + 1 == cap_start + cap_n {
                    let _ = std::fs::write("ux0:data/openstrike-vita/cap/done", b"ok\n");
                    loop {
                        std::thread::yield_now();
                    }
                }
            }
        }
        let mut request = dev.poll();
        let op = request.as_ref().map(|r| r.command.op).or(match action {
            Action::Reload => Some(Op::Reload),
            Action::Reset => Some(Op::Reset),
            Action::Capture => Some(Op::Capture),
            Action::None => None,
        });
        match op {
            Some(Op::Status) => {
                let mut status = dev.status(frame, output);
                status["game"] = app
                    .as_ref()
                    .map(|a| a.status())
                    .unwrap_or(serde_json::Value::Null);
                request.take().unwrap().finish(Ok(status));
            }
            Some(Op::Menu) => {
                dev.menu.visible = !dev.menu.visible;
                request
                    .take()
                    .unwrap()
                    .finish(Ok(serde_json::json!({"menu":dev.menu.visible})));
            }
            Some(Op::Capture) => {
                if let Some(request) = request.take() {
                    let _ = request.reply.try_send(dev.capture(frame));
                } else {
                    dev.capture_from_menu(frame);
                }
            }
            Some(Op::Push | Op::Reload | Op::Reset) => {
                let previous = active.clone();
                let hash = dev.active_hash.clone();
                if op == Some(Op::Push) {
                    active = request.as_mut().unwrap().bundle.take().map(Arc::new);
                }
                if op == Some(Op::Reset) {
                    active = None;
                }
                stop(&mut app);
                switch::cancel_pending();
                candidate = Some(Candidate {
                    request: request.take(),
                    previous,
                    hash,
                });
                match App::boot(&active, now(frame)) {
                    Ok(guest) => {
                        app = Some(guest);
                        dev.active_hash = active
                            .as_ref()
                            .map(|b| b.hash.clone())
                            .unwrap_or_else(|| embedded_hash.clone());
                    }
                    Err(error) => recover(
                        &mut app,
                        &mut active,
                        &mut candidate,
                        &mut dev,
                        error,
                        now(frame),
                    ),
                }
            }
            Some(Op::Native) => {
                let request = request.take().unwrap();
                stop(&mut app);
                let result = dev::exec_native(request.native_path.as_ref().unwrap());
                match App::boot(&active, now(frame)) {
                    Ok(guest) => app = Some(guest),
                    Err(error) => {
                        dev.error = error;
                        dev.menu.visible = true;
                    }
                }
                request.finish(result.map(|_| serde_json::json!({})));
            }
            None => {}
        }
        frame = frame.wrapping_add(1);
    }
}
