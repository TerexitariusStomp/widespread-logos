//! Widespread Wallet desktop shell.
//!
//! Hosts the shared wallet-ui bundle and bridges its `TauriBackend` calls to
//! `wsp-lezd` — the same native helper the browser extension drives over
//! native messaging. The helper is spawned as a sidecar (`externalBin`), ops
//! travel as u32-LE length-prefixed JSON frames on stdio, and the sealed
//! vault blob lives in the app-data dir (`vault_blob_get/set`). Key material
//! never enters the WebView — the frontend sees only op replies.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

const MAX_FRAME: usize = 8 * 1024 * 1024; // generous headroom over Chromium's 1 MiB

struct Helper {
    _child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl Helper {
    fn spawn(app: &AppHandle) -> Result<Self> {
        // Tauri resolves externalBin to the platform-suffixed binary in the
        // bundle; in dev it falls back to `wsp-lezd` on PATH.
        let resource = app
            .path()
            .resource_dir()
            .ok()
            .map(|d| d.join("binaries").join("wsp-lezd"));
        let bin = resource
            .filter(|p| p.exists())
            .unwrap_or_else(|| "wsp-lezd".into());
        let mut child = Command::new(&bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawn {}", bin.display()))?;
        Ok(Self {
            stdin: child.stdin.take().context("helper stdin")?,
            stdout: child.stdout.take().context("helper stdout")?,
            _child: child,
        })
    }

    fn call(&mut self, op: &Value) -> Result<Value> {
        let payload = serde_json::to_vec(&serde_json::json!({ "id": 1, "op": op }))?;
        self.stdin
            .write_all(&(payload.len() as u32).to_le_bytes())?;
        self.stdin.write_all(&payload)?;
        self.stdin.flush()?;

        let mut len_buf = [0u8; 4];
        self.stdout.read_exact(&mut len_buf)?;
        let len = u32::from_le_bytes(len_buf) as usize;
        if len > MAX_FRAME {
            bail!("helper frame {len} exceeds limit");
        }
        let mut buf = vec![0u8; len];
        self.stdout.read_exact(&mut buf)?;
        Ok(serde_json::from_slice(&buf)?)
    }
}

struct HelperState(Mutex<Option<Helper>>);

#[tauri::command]
fn lez_op(app: AppHandle, state: State<HelperState>, op: Value) -> Result<Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(Helper::spawn(&app).map_err(|e| e.to_string())?);
    }
    let reply = guard.as_mut().unwrap().call(&op).map_err(|e| {
        *guard = None; // dead helper — respawn on next call
        e.to_string()
    })?;
    if let Some(err) = reply.get("error").and_then(Value::as_str) {
        return Err(err.to_string());
    }
    Ok(reply.get("output").cloned().unwrap_or(reply))
}

fn blob_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("lez-vault.blob"))
}

#[tauri::command]
fn vault_blob_get(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(blob_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn vault_blob_set(app: AppHandle, b64: String) -> Result<(), String> {
    let path = blob_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, b64)
        .map_err(|e| -> String { anyhow!(e).context(path.display().to_string()).to_string() })
}

fn main() {
    tauri::Builder::default()
        .manage(HelperState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            lez_op,
            vault_blob_get,
            vault_blob_set
        ])
        .run(tauri::generate_context!())
        .expect("error while running widespread-wallet");
}
