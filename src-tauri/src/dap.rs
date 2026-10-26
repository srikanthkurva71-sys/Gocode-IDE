use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    thread,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

const MAX_DAP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct DapState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, DapSession>>,
}

struct DapSession {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone, Serialize)]
struct DapEvent {
    session_id: String,
    message: Value,
}

fn write_dap_message(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| format!("Cannot encode DAP message: {e}"))?;
    if body.len() > MAX_DAP_MESSAGE_BYTES {
        return Err("DAP message exceeds the 8 MiB safety limit.".into());
    }
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Cannot write to debug adapter: {e}"))
}

fn read_dap_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut content_length = None;
    let mut header_bytes = 0usize;
    loop {
        let mut line = String::new();
        let count = reader.read_line(&mut line).map_err(|e| format!("Cannot read DAP header: {e}"))?;
        if count == 0 {
            if header_bytes == 0 { return Ok(None); }
            return Err("Debug adapter closed in the middle of a header.".into());
        }
        header_bytes += count;
        if header_bytes > 16 * 1024 { return Err("DAP headers exceed the 16 KiB safety limit.".into()); }
        if line == "\r\n" || line == "\n" { break; }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("Content-Length") {
                if content_length.is_some() {
                    return Err("Duplicate Content-Length header.".into());
                }
                let parsed = value.trim().parse::<usize>().map_err(|_| "Invalid DAP Content-Length header.".to_string())?;
                if parsed > MAX_DAP_MESSAGE_BYTES { return Err("Debug-adapter message exceeds the 8 MiB safety limit.".into()); }
                content_length = Some(parsed);
            }
        }
    }
    let length = content_length.ok_or_else(|| "DAP message has no Content-Length header.".to_string())?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| format!("Incomplete DAP message: {e}"))?;
    serde_json::from_slice(&body).map(Some).map_err(|e| format!("Invalid JSON from debug adapter: {e}"))
}

#[tauri::command]
pub fn dap_start(app: AppHandle, state: State<'_, DapState>, executable: String, args: Vec<String>) -> Result<String, String> {
    let executable = executable.trim();
    if executable.is_empty() || executable.len() > 4096 {
        return Err("Choose a valid debug-adapter executable path.".into());
    }
    if args.len() > 64 || args.iter().any(|arg| arg.len() > 4096) {
        return Err("Debug-adapter arguments exceed the configured limits.".into());
    }
    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().map_err(|e| format!("Cannot start debug adapter. Check the executable path and arguments: {e}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "Debug-adapter stdin is unavailable.".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Debug-adapter stdout is unavailable.".to_string())?;
    let id = format!("dap-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let event_app = app.clone();
    let event_id = id.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_dap_message(&mut reader) {
                Ok(Some(message)) => {
                    if event_app.emit("dap-message", DapEvent { session_id: event_id.clone(), message }).is_err() { break; }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = event_app.emit("dap-error", serde_json::json!({"session_id": event_id, "message": error}));
                    break;
                }
            }
        }
        let _ = event_app.emit("dap-exited", serde_json::json!({"session_id": event_id}));
    });
    let mut session = DapSession { child, stdin };
    write_dap_message(&mut session.stdin, &serde_json::json!({
        "seq": 1,
        "type": "request",
        "command": "initialize",
        "arguments": {
            "clientID": "gocode-ide",
            "clientName": "Gocode IDE",
            "adapterID": "user-configured",
            "locale": "en",
            "linesStartAt1": true,
            "columnsStartAt1": true,
            "pathFormat": "path",
            "supportsVariableType": true,
            "supportsRunInTerminalRequest": false,
            "supportsProgressReporting": true
        }
    }))?;
    state.sessions.lock().map_err(|_| "Debug-adapter state is unavailable.".to_string())?.insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
pub fn dap_send(state: State<'_, DapState>, session_id: String, message: Value) -> Result<(), String> {
    if message.as_object().is_none() || message.get("type").and_then(Value::as_str) != Some("request") {
        return Err("DAP message must be a request object.".into());
    }
    if message.get("seq").and_then(Value::as_u64).is_none() || message.get("command").and_then(Value::as_str).is_none() {
        return Err("DAP request needs a numeric seq and command string.".into());
    }
    let mut sessions = state.sessions.lock().map_err(|_| "Debug-adapter state is unavailable.".to_string())?;
    let session = sessions.get_mut(&session_id).ok_or_else(|| "Debug-adapter session was not found.".to_string())?;
    write_dap_message(&mut session.stdin, &message)
}

#[tauri::command]
pub fn dap_stop(state: State<'_, DapState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Debug-adapter state is unavailable.".to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read_dap_message, write_dap_message, MAX_DAP_MESSAGE_BYTES};
    use serde_json::json;
    use std::io::{BufReader, Cursor};

    #[test]
    fn rejects_duplicate_content_length_headers() {
        let frame = b"Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}";
        let result = read_dap_message(&mut BufReader::new(Cursor::new(frame)));
        assert!(result.unwrap_err().contains("Duplicate Content-Length"));
    }

    #[test]
    fn parses_dap_frame_and_case_insensitive_header() {
        let body = br#"{"seq":1,"type":"response","command":"initialize","success":true}"#;
        let frame = format!("content-length: {}\r\n\r\n{}", body.len(), std::str::from_utf8(body).unwrap());
        let parsed = read_dap_message(&mut BufReader::new(Cursor::new(frame))).unwrap().unwrap();
        assert_eq!(parsed["command"], "initialize");
    }

    #[test]
    fn parses_two_messages_in_sequence() {
        let a = br#"{"seq":1,"type":"event","event":"initialized"}"#;
        let b = br#"{"seq":2,"type":"event","event":"terminated"}"#;
        let frame = format!("Content-Length: {}\r\n\r\n{}Content-Length: {}\r\n\r\n{}",
            a.len(), std::str::from_utf8(a).unwrap(), b.len(), std::str::from_utf8(b).unwrap());
        let mut reader = BufReader::new(Cursor::new(frame));
        assert_eq!(read_dap_message(&mut reader).unwrap().unwrap()["event"], "initialized");
        assert_eq!(read_dap_message(&mut reader).unwrap().unwrap()["event"], "terminated");
        assert!(read_dap_message(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_missing_and_oversized_content_length() {
        assert!(read_dap_message(&mut BufReader::new(Cursor::new(b"Header: x\r\n\r\n{}"))).is_err());
        let frame = format!("Content-Length: {}\r\n\r\n", MAX_DAP_MESSAGE_BYTES + 1);
        assert!(read_dap_message(&mut BufReader::new(Cursor::new(frame))).is_err());
    }

    #[test]
    fn writes_framed_json() {
        let mut output = Vec::new();
        write_dap_message(&mut output, &json!({"seq": 2, "type": "request", "command": "continue"})).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.starts_with("Content-Length: "));
        assert!(text.contains("\r\n\r\n{"));
    }
}
