//! wsp-lezd — the extension-side LEZ wallet daemon.
//!
//! Speaks the browser native-messaging protocol: each request is a 4-byte
//! little-endian length prefix followed by a JSON message; replies use the
//! same framing on stdout. The binary holds no durable state — the unlocked
//! wallet lives in session RAM only and is wiped on `lock` or disconnect.
//!
//! Message envelope:
//!   { "id": <u64>, "op": { ...Op } }
//! Reply:
//!   { "id": <u64>, "ok": true,  "output": { ...Output } }
//!   { "id": <u64>, "ok": false, "error": "<message>" }

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::io::FromRawFd;

use serde::{Deserialize, Serialize};
use wsp_lez_core::{Op, Output, Worker};

#[derive(Debug, Deserialize)]
struct Request {
    id: u64,
    op: Op,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Reply {
    Ok { id: u64, ok: bool, output: Box<Output> },
    Err { id: u64, ok: bool, error: String },
}

fn read_frame(stdin: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match stdin.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    // Native messaging hard limit is 1 MiB per message in Chromium; allow
    // generous headroom for blobs but reject absurd frames.
    const MAX_FRAME: usize = 32 * 1024 * 1024;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn write_frame(stdout: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = (payload.len() as u32).to_le_bytes();
    stdout.write_all(&len)?;
    stdout.write_all(payload)?;
    stdout.flush()
}

/// The upstream wallet engine writes progress with `println!` — fatal on a
/// channel where stdout is the wire. Move the wire to a duplicated fd and
/// point fd 1 at /dev/null so upstream prints can't corrupt frames.
fn take_wire_stdout() -> io::Result<File> {
    unsafe {
        let wire = libc::dup(libc::STDOUT_FILENO);
        if wire < 0 {
            return Err(io::Error::last_os_error());
        }
        let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
        if devnull < 0 || libc::dup2(devnull, libc::STDOUT_FILENO) < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(File::from_raw_fd(wire))
    }
}

fn main() -> anyhow::Result<()> {
    let mut output = take_wire_stdout()?;
    // stderr is free in native messaging; the dup'd fd is the wire.
    eprintln!(
        "wsp-lezd: native-messaging host up (protocol v{})",
        wsp_lez_core::PROTOCOL_VERSION
    );

    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut worker = Worker::new()?;

    while let Some(frame) = read_frame(&mut input)? {
        let reply = match serde_json::from_slice::<Request>(&frame) {
            Err(e) => Reply::Err {
                id: 0,
                ok: false,
                error: format!("bad request: {e}"),
            },
            Ok(req) => match worker.execute(req.op) {
                Ok(output) => Reply::Ok {
                    id: req.id,
                    ok: true,
                    output: Box::new(output),
                },
                Err(e) => Reply::Err {
                    id: req.id,
                    ok: false,
                    error: format!("{e:#}"),
                },
            },
        };
        let payload = serde_json::to_vec(&reply)?;
        write_frame(&mut output, &payload)?;
    }

    // stdin closed (extension disconnected): Worker drops, session wipes.
    eprintln!("wsp-lezd: channel closed, session wiped");
    Ok(())
}
