use std::{
    collections::HashMap,
    time::{Duration, Instant},
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    thread,
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

const MAX_LSP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct LspState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, LspSession>>,
}

impl Drop for LspState {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for (_, mut session) in sessions.drain() {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
    }
}

struct LspSession {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone, Serialize)]
struct LspEvent {
    session_id: String,
    message: Value,
}

fn percent_decode_uri_path(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Invalid percent escape in language-server file URI.".into());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| "Invalid percent escape in language-server file URI.".to_string())?;
            let value = u8::from_str_radix(hex, 16)
                .map_err(|_| "Invalid percent escape in language-server file URI.".to_string())?;
            decoded.push(value);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded)
        .map_err(|_| "Language-server file URI path is not valid UTF-8.".into())
}

fn write_lsp_message(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| format!("Cannot encode LSP message: {e}"))?;
    if body.len() > MAX_LSP_MESSAGE_BYTES {
        return Err("LSP message exceeds the 8 MiB safety limit.".into());
    }
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Cannot write to language server: {e}"))
}

fn read_lsp_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut content_length = None;
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        // Bound the read itself, not just the counter after read_line: a malicious
        // or broken server must not be able to force an unbounded header allocation.
        let remaining = 16 * 1024usize - header_bytes;
        let count = reader.take((remaining + 1) as u64).read_line(&mut line)
            .map_err(|e| format!("Cannot read language-server header: {e}"))?;
        if count > remaining {
            return Err("Language-server headers exceed the 16 KiB safety limit.".into());
        }
        if count == 0 {
            if header_bytes == 0 { return Ok(None); }
            return Err("Language server closed in the middle of a header.".into());
        }
        header_bytes += count;
        if header_bytes > 16 * 1024 {
            return Err("Language-server headers exceed the 16 KiB safety limit.".into());
        }
        if line == "\r\n" || line == "\n" { break; }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("Content-Length") {
                if content_length.is_some() {
                    return Err("Duplicate Content-Length header.".into());
                }
                let parsed = value.trim().parse::<usize>()
                    .map_err(|_| "Invalid LSP Content-Length header.".to_string())?;
                if parsed > MAX_LSP_MESSAGE_BYTES {
                    return Err("Language-server message exceeds the 8 MiB safety limit.".into());
                }
                content_length = Some(parsed);
            }
        }
    }
    let length = content_length.ok_or_else(|| "Language-server message has no Content-Length header.".to_string())?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| format!("Incomplete language-server message: {e}"))?;
    serde_json::from_slice(&body).map(Some).map_err(|e| format!("Invalid JSON from language server: {e}"))
}

#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<'_, LspState>,
    executable: String,
    args: Vec<String>,
    root_uri: Option<String>,
) -> Result<String, String> {
    let executable = executable.trim();
    if executable.is_empty() || executable.len() > 4096 {
        return Err("Choose a valid language-server executable path.".into());
    }
    if args.len() > 64 || args.iter().any(|arg| arg.len() > 4096) {
        return Err("Language-server arguments exceed the configured limits.".into());
    }

    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(uri) = root_uri.as_deref() {
        if let Some(path) = uri.strip_prefix("file://") {
            #[cfg(windows)]
            let path = path.strip_prefix('/').filter(|value| value.as_bytes().get(1) == Some(&b':')).unwrap_or(path);
            let decoded = percent_decode_uri_path(path)?;
            let root = PathBuf::from(decoded);
            if root.is_dir() { command.current_dir(root); }
        }
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot start language server. Check the executable path and arguments: {e}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "Language server stdin is unavailable.".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Language server stdout is unavailable.".to_string())?;

    let id = format!("lsp-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let event_app = app.clone();
    let event_id = id.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_lsp_message(&mut reader) {
                Ok(Some(message)) => {
                    if event_app.emit("lsp-message", LspEvent { session_id: event_id.clone(), message }).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = event_app.emit("lsp-error", json!({"session_id": event_id, "message": error}));
                    break;
                }
            }
        }
        let _ = event_app.emit("lsp-exited", json!({"session_id": event_id}));
    });

    let mut session = LspSession { child, stdin };
    // The frontend sends initialize only after subscribing to session events,
    // preventing fast language servers from replying before listeners exist.
    state.sessions.lock().map_err(|_| "Language-server state is unavailable.".to_string())?
        .insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(state: State<'_, LspState>, session_id: String, message: Value) -> Result<(), String> {
    if message.as_object().is_none() || message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err("LSP message must be a JSON-RPC 2.0 object.".into());
    }
    let mut sessions = state.sessions.lock().map_err(|_| "Language-server state is unavailable.".to_string())?;
    let session = sessions.get_mut(&session_id).ok_or_else(|| "Language-server session was not found.".to_string())?;
    write_lsp_message(&mut session.stdin, &message)
}

#[tauri::command]
pub fn lsp_stop(state: State<'_, LspState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Language-server state is unavailable.".to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{percent_decode_uri_path, read_lsp_message, write_lsp_message, MAX_LSP_MESSAGE_BYTES};
    use serde_json::json;
    use std::io::{BufReader, Cursor};

    #[test]
    fn decodes_percent_encoded_uri_paths() {
        assert_eq!(percent_decode_uri_path("/tmp/a%20folder/file%23one.rs").unwrap(), "/tmp/a folder/file#one.rs");
        assert_eq!(percent_decode_uri_path("/tmp/%E2%9C%93.rs").unwrap(), "/tmp/✓.rs");
    }

    #[test]
    fn rejects_invalid_percent_encoded_uri_paths() {
        assert!(percent_decode_uri_path("/tmp/%").is_err());
        assert!(percent_decode_uri_path("/tmp/%GG").is_err());
        assert!(percent_decode_uri_path("/tmp/%FF").is_err());
    }

    #[test]
    fn rejects_duplicate_content_length_headers() {
        let frame = b"Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}";
        let result = read_lsp_message(&mut BufReader::new(Cursor::new(frame)));
        assert!(result.unwrap_err().contains("Duplicate Content-Length"));
    }

    #[test]
    fn parses_message_and_case_insensitive_header() {
        let body = br#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let frame = format!("content-length: {}\r\n\r\n{}", body.len(), std::str::from_utf8(body).unwrap());
        let parsed = read_lsp_message(&mut BufReader::new(Cursor::new(frame))).unwrap().unwrap();
        assert_eq!(parsed["id"], 1);
    }

    #[test]
    fn parses_multiple_messages_from_one_stream() {
        let first = br#"{"jsonrpc":"2.0","id":1}"#;
        let second = br#"{"jsonrpc":"2.0","id":2}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{}Content-Length: {}\r\n\r\n{}",
            first.len(), std::str::from_utf8(first).unwrap(), second.len(), std::str::from_utf8(second).unwrap());
        let mut reader = BufReader::new(Cursor::new(frame));
        assert_eq!(read_lsp_message(&mut reader).unwrap().unwrap()["id"], 1);
        assert_eq!(read_lsp_message(&mut reader).unwrap().unwrap()["id"], 2);
        assert!(read_lsp_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_missing_content_length() {
        let frame = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
        assert!(read_lsp_message(&mut BufReader::new(Cursor::new(frame))).is_err());
    }

    #[test]
    fn rejects_oversized_content_length() {
        let frame = format!("Content-Length: {}\r\n\r\n", MAX_LSP_MESSAGE_BYTES + 1);
        assert!(read_lsp_message(&mut BufReader::new(Cursor::new(frame))).is_err());
    }

    #[test]
    fn writes_framed_json_rpc() {
        let mut out = Vec::new();
        write_lsp_message(&mut out, &json!({"jsonrpc":"2.0","id":1})).unwrap();
        let frame = String::from_utf8(out).unwrap();
        assert!(frame.starts_with("Content-Length: "));
        assert!(frame.contains("\r\n\r\n{"));
    }

    #[test]
    fn rejects_unterminated_oversized_header_without_unbounded_read() {
        let bytes = vec![b'A'; 20 * 1024];
        let result = read_lsp_message(&mut BufReader::new(Cursor::new(bytes)));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("16 KiB"));
    }
}
