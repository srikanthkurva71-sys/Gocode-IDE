//! Bounded JSON-RPC framing primitives for Language Server Protocol stdio.
//! This module deliberately does not launch language servers yet. It provides
//! protocol framing that can be tested independently before process integration.

use serde_json::Value;

pub const MAX_LSP_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

#[derive(Debug, PartialEq)]
pub enum FrameError {
    HeaderTooLarge,
    MissingHeaderTerminator,
    MissingContentLength,
    InvalidContentLength,
    PayloadTooLarge,
    InvalidUtf8,
    InvalidJson,
}

#[derive(Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    /// Append arbitrary bytes and decode every complete LSP frame available.
    /// Partial headers and payloads are retained until the next call.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, FrameError> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();

        loop {
            let header_end = match self.buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                Some(position) => position,
                None => {
                    if self.buffer.len() > MAX_HEADER_BYTES {
                        return Err(FrameError::HeaderTooLarge);
                    }
                    break;
                }
            };
            if header_end > MAX_HEADER_BYTES {
                return Err(FrameError::HeaderTooLarge);
            }

            let header = std::str::from_utf8(&self.buffer[..header_end])
                .map_err(|_| FrameError::InvalidUtf8)?;
            let mut content_length = None;
            for line in header.split("\r\n") {
                if let Some((name, value)) = line.split_once(':') {
                    if name.trim().eq_ignore_ascii_case("content-length") {
                        if content_length.is_some() {
                            return Err(FrameError::InvalidContentLength);
                        }
                        content_length = Some(
                            value.trim().parse::<usize>()
                                .map_err(|_| FrameError::InvalidContentLength)?
                        );
                    }
                }
            }
            let length = content_length.ok_or(FrameError::MissingContentLength)?;
            if length > MAX_LSP_MESSAGE_BYTES {
                return Err(FrameError::PayloadTooLarge);
            }

            let payload_start = header_end + 4;
            let frame_end = payload_start.checked_add(length)
                .ok_or(FrameError::PayloadTooLarge)?;
            if self.buffer.len() < frame_end {
                break;
            }

            let payload = std::str::from_utf8(&self.buffer[payload_start..frame_end])
                .map_err(|_| FrameError::InvalidUtf8)?;
            let value = serde_json::from_str::<Value>(payload)
                .map_err(|_| FrameError::InvalidJson)?;
            messages.push(value);
            self.buffer.drain(..frame_end);
        }
        Ok(messages)
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len()
    }
}

pub fn encode_message(value: &Value) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(value).map_err(|_| FrameError::InvalidJson)?;
    if body.len() > MAX_LSP_MESSAGE_BYTES {
        return Err(FrameError::PayloadTooLarge);
    }
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn decodes_one_message() {
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.push(&frame(r#"{"jsonrpc":"2.0","id":1}"#)).unwrap(),
            vec![serde_json::json!({"jsonrpc":"2.0","id":1})]);
        assert_eq!(decoder.buffered_bytes(), 0);
    }

    #[test]
    fn supports_partial_header_and_payload() {
        let mut decoder = FrameDecoder::new();
        let bytes = frame(r#"{"jsonrpc":"2.0","method":"initialized"}"#);
        let split = 12;
        assert!(decoder.push(&bytes[..split]).unwrap().is_empty());
        assert!(decoder.push(&bytes[split..split + 10]).unwrap().is_empty());
        assert_eq!(decoder.push(&bytes[split + 10..]).unwrap(),
            vec![serde_json::json!({"jsonrpc":"2.0","method":"initialized"})]);
    }

    #[test]
    fn decodes_multiple_messages_from_one_chunk() {
        let mut decoder = FrameDecoder::new();
        let mut bytes = frame(r#"{"id":1}"#);
        bytes.extend(frame(r#"{"id":2}"#));
        assert_eq!(decoder.push(&bytes).unwrap(),
            vec![serde_json::json!({"id":1}), serde_json::json!({"id":2})]);
    }

    #[test]
    fn rejects_missing_or_invalid_content_length() {
        let mut missing = FrameDecoder::new();
        assert_eq!(missing.push(b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}"),
            Err(FrameError::MissingContentLength));
        let mut invalid = FrameDecoder::new();
        assert_eq!(invalid.push(b"Content-Length: nope\r\n\r\n{}"),
            Err(FrameError::InvalidContentLength));
    }

    #[test]
    fn rejects_invalid_json_and_oversized_payload() {
        let mut invalid_json = FrameDecoder::new();
        assert_eq!(invalid_json.push(&frame("{")), Err(FrameError::InvalidJson));
        let mut oversized = FrameDecoder::new();
        let header = format!("Content-Length: {}\r\n\r\n", MAX_LSP_MESSAGE_BYTES + 1);
        assert_eq!(oversized.push(header.as_bytes()), Err(FrameError::PayloadTooLarge));
    }

    #[test]
    fn encoder_round_trips() {
        let value = serde_json::json!({"jsonrpc":"2.0","method":"initialize","id":1});
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.push(&encode_message(&value).unwrap()).unwrap(), vec![value]);
    }
}
