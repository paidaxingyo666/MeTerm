/// vibrancy.rs — Anti-flash for macOS vibrancy (minimize + Stage Manager).
///
/// When NSVisualEffectView stops compositing (minimize, Stage Manager, etc.),
/// a transparent window shows a flash. We mitigate this by:
///   1. Setting NSWindow.backgroundColor to a theme-matching solid color as
///      fallback when vibrancy temporarily disengages (covers Stage Manager).
///   2. Setting alphaValue=0 after minimize, restoring on deminiaturize
///      (covers the minimize/restore animation).

#[cfg(target_os = "macos")]
mod inner {
    use objc2::rc::Retained;
    use objc2_foundation::NSObject;

    /// Holds observer tokens. Dropping them unregisters the notifications.
    pub struct VibrancyGuard {
        _observers: Vec<Retained<NSObject>>,
    }

    unsafe impl Send for VibrancyGuard {}
    unsafe impl Sync for VibrancyGuard {}

    /// Set the NSWindow backgroundColor to a solid fallback color.
    /// This color shows through when vibrancy briefly disengages.
    pub fn set_vibrancy_fallback_color(
        window: &tauri::WebviewWindow,
        r: f64,
        g: f64,
        b: f64,
    ) -> Result<(), String> {
        use objc2_app_kit::{NSColor, NSWindow};

        let ns_window_raw =
            window.ns_window().map_err(|e| e.to_string())?;
        let ns_window = unsafe { &*(ns_window_raw as *const NSWindow) };

        let color = unsafe {
            NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0)
        };
        ns_window.setBackgroundColor(Some(&color));

        Ok(())
    }

    /// Register minimize anti-flash observers for a Tauri window.
    pub fn register_vibrancy_anti_flash(
        window: &tauri::WebviewWindow,
    ) -> Result<VibrancyGuard, String> {
        use std::ptr::NonNull;
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{
            NSWindow, NSWindowDidDeminiaturizeNotification,
            NSWindowDidMiniaturizeNotification,
        };
        use objc2_foundation::{NSNotification, NSNotificationCenter};

        let ns_window_raw =
            window.ns_window().map_err(|e| e.to_string())?;
        let addr = ns_window_raw as usize;

        let center = unsafe { NSNotificationCenter::defaultCenter() };
        let obj: &AnyObject = unsafe { &*(addr as *const AnyObject) };

        let mut observers = Vec::new();

        // --- DidMiniaturize: set alpha=0 (window is in Dock, invisible) ---
        let a1 = addr;
        let b1 = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            unsafe {
                let w = &*(a1 as *const NSWindow);
                let _: () = msg_send![w, setAlphaValue: 0.0_f64];
            }
        });
        observers.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidMiniaturizeNotification),
                Some(obj),
                None,
                &b1,
            )
        });

        // --- DidDeminiaturize: restore alpha=1 ---
        let a2 = addr;
        let b2 = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            unsafe {
                let w = &*(a2 as *const NSWindow);
                let _: () = msg_send![w, setAlphaValue: 1.0_f64];
            }
        });
        observers.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidDeminiaturizeNotification),
                Some(obj),
                None,
                &b2,
            )
        });

        Ok(VibrancyGuard {
            _observers: observers,
        })
    }
}

#[cfg(target_os = "macos")]
pub use inner::*;

/// No-op on non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub struct VibrancyGuard;
