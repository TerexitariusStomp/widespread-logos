//! wsp-lez-ffi — C ABI facade over the Widespread LEZ wallet worker.
//!
//! The mobile transport for `wsp-lez-core`: Android (JNI → `libwsp_lez_ffi.so`)
//! and iOS (static link → `libwsp_lez_ffi.a`) embedders drive the same
//! `execute(op) -> output` protocol the native-messaging host and Logos module
//! use. One call shape, JSON in / JSON out:
//!
//! ```text
//! wsp_lez_worker_execute(h, req_ptr, req_len, &mut out, &mut out_len)
//!   req  = UTF-8 JSON Op      ({"op":"ping"} … — serde tag, see op.rs)
//!   out  = UTF-8 JSON Output  ({"type":"pong",…})        on rc == 0
//!        or {"type":"error","message":…}                 on rc != 0
//! ```
//!
//! Ownership rules:
//!   * `wsp_lez_worker_new` returns an opaque handle; release it once with
//!     `wsp_lez_worker_free`. A handle owns one unlocked session — serialize
//!     calls per handle (the worker is not internally synchronized).
//!   * `*out` buffers are heap-allocated by this library and MUST be released
//!     with `wsp_lez_free(ptr, len)` — including error responses.
//!   * Inputs are borrowed for the call only; no aliasing requirements beyond
//!     readability of `req_len` bytes.
//!
//! Custody note: the vault blob (`blob_b64` in `init`/`restore`/`export_blob`
//! results) is plaintext serialized storage — the embedder owns sealing it
//! (Android Keystore / iOS Keychain) before it touches disk or the network,
//! exactly as the desktop vault does.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;

use wsp_lez_core::{Op, Worker};

/// Opaque worker handle — wraps `wsp_lez_core::Worker` (one unlocked session).
#[repr(C)]
pub struct WspLezWorker {
    inner: Worker,
}

/// A JSON error response, shaped like an `Output` variant for callers that
/// switch on `type` without a separate error path.
fn error_json(message: impl std::fmt::Display) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "type": "error",
        "message": message.to_string(),
    }))
    .unwrap_or_else(|_| b"{\"type\":\"error\",\"message\":\"serialization\"}".to_vec())
}

fn leak_out(v: Vec<u8>, out: *mut *mut u8, out_len: *mut usize) {
    let boxed = v.into_boxed_slice();
    let len = boxed.len();
    let ptr = Box::into_raw(boxed) as *mut u8;
    unsafe {
        // out/out_len are checked non-null by callers in `wsp_lez_worker_execute`.
        *out = ptr;
        *out_len = len;
    }
}

/// Create a worker. Returns NULL if the tokio runtime cannot start.
#[unsafe(no_mangle)]
pub extern "C" fn wsp_lez_worker_new() -> *mut WspLezWorker {
    match catch_unwind(Worker::new) {
        Ok(Ok(inner)) => Box::into_raw(Box::new(WspLezWorker { inner })),
        _ => std::ptr::null_mut(),
    }
}

/// Destroy a worker created by `wsp_lez_worker_new`. NULL is a no-op.
///
/// # Safety
/// `worker` must be a handle returned by `wsp_lez_worker_new`, or NULL.
/// It must not be used after this call, and must not be freed twice.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsp_lez_worker_free(worker: *mut WspLezWorker) {
    if !worker.is_null() {
        drop(unsafe { Box::from_raw(worker) });
    }
}

/// Run one op against the worker.
///
/// Returns 0 on success, non-zero on failure; either way `*out`/`*out_len`
/// describe a JSON buffer the caller frees with `wsp_lez_free`.
///
/// # Safety
/// * `worker` must be a live handle from `wsp_lez_worker_new`.
/// * `req` must be readable for `req_len` bytes (may be non-UTF-8; that is a
///   normal error result, not UB). `req` may be NULL only when `req_len == 0`.
/// * `out` and `out_len` must be valid, writable pointers.
/// * Calls on one handle must be serialized by the caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsp_lez_worker_execute(
    worker: *mut WspLezWorker,
    req: *const u8,
    req_len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out.is_null() || out_len.is_null() {
        return -1;
    }
    unsafe {
        *out = std::ptr::null_mut();
        *out_len = 0;
    }
    if worker.is_null() {
        leak_out(error_json("null worker handle"), out, out_len);
        return -1;
    }
    if req.is_null() && req_len > 0 {
        leak_out(error_json("null request buffer"), out, out_len);
        return -1;
    }

    let rc = catch_unwind(AssertUnwindSafe(|| {
        let bytes = unsafe { slice::from_raw_parts(req, req_len) };
        let op: Op = match serde_json::from_slice(bytes) {
            Ok(op) => op,
            Err(e) => return Err(error_json(format!("bad op JSON: {e}"))),
        };
        match unsafe { &mut *worker }.inner.execute(op) {
            Ok(output) => Ok(serde_json::to_vec(&output).unwrap_or_else(|_| {
                error_json("output serialization failed")
            })),
            Err(e) => Err(error_json(format!("{e:#}"))),
        }
    }));

    match rc {
        Ok(Ok(payload)) => {
            leak_out(payload, out, out_len);
            0
        }
        Ok(Err(payload)) => {
            leak_out(payload, out, out_len);
            1
        }
        Err(_) => {
            leak_out(error_json("panic in worker"), out, out_len);
            -1
        }
    }
}

/// Free a buffer returned in `*out` by `wsp_lez_worker_execute`.
///
/// # Safety
/// `ptr`/`len` must be a pair produced by this library, or `ptr` NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wsp_lez_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(unsafe { Box::from_raw(slice::from_raw_parts_mut(ptr, len)) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn exec(h: *mut WspLezWorker, req: &str) -> (i32, serde_json::Value) {
        let mut out: *mut u8 = std::ptr::null_mut();
        let mut out_len = 0usize;
        let rc = unsafe {
            wsp_lez_worker_execute(h, req.as_ptr(), req.len(), &mut out, &mut out_len)
        };
        assert!(!out.is_null());
        let v: serde_json::Value =
            serde_json::from_slice(unsafe { slice::from_raw_parts(out, out_len) }).unwrap();
        unsafe { wsp_lez_free(out, out_len) };
        (rc, v)
    }

    #[test]
    fn ping_roundtrip() {
        let h = wsp_lez_worker_new();
        assert!(!h.is_null());
        let (rc, v) = unsafe { exec(h, r#"{"op":"ping"}"#) };
        assert_eq!(rc, 0);
        assert_eq!(v["type"], "pong");
        unsafe { wsp_lez_worker_free(h) };
    }

    #[test]
    fn bad_json_is_error_not_crash() {
        let h = wsp_lez_worker_new();
        let (rc, v) = unsafe { exec(h, "not json") };
        assert_eq!(rc, 1);
        assert_eq!(v["type"], "error");
        unsafe { wsp_lez_worker_free(h) };
    }

    #[test]
    fn null_worker_errors() {
        let mut out: *mut u8 = std::ptr::null_mut();
        let mut out_len = 0usize;
        let rc = unsafe {
            wsp_lez_worker_execute(std::ptr::null_mut(), b"{}".as_ptr(), 2, &mut out, &mut out_len)
        };
        assert_eq!(rc, -1);
        assert!(!out.is_null());
        unsafe { wsp_lez_free(out, out_len) };
    }

    #[test]
    fn session_survives_across_calls() {
        let h = wsp_lez_worker_new();
        let (rc, v) = unsafe { exec(h, r#"{"op":"init"}"#) };
        assert_eq!(rc, 0);
        let blob = v["blob_b64"].as_str().unwrap().to_string();

        let (rc, _) = unsafe { exec(h, r#"{"op":"lock"}"#) };
        assert_eq!(rc, 0);

        // A fresh worker unlocks from the exported blob.
        let h2 = wsp_lez_worker_new();
        let (rc, v) = unsafe {
            exec(h2, &serde_json::json!({"op":"unlock","blob_b64":blob}).to_string())
        };
        assert_eq!(rc, 0);
        assert_eq!(v["type"], "unlocked");
        unsafe {
            wsp_lez_worker_free(h);
            wsp_lez_worker_free(h2);
        }
    }
}
