#!/usr/bin/env python3
"""Smoke-test a real rust-analyzer process using the LSP stdio transport."""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def fail(message):
    raise SystemExit(f"rust-analyzer LSP smoke test failed: {message}")


def read_exact(stream, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("truncated LSP message")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def reader(stream, messages, errors):
    try:
        while True:
            headers = {}
            while True:
                line = stream.readline()
                if not line:
                    return
                if line in (b"\r\n", b"\n"):
                    break
                name, separator, value = line.decode("ascii").partition(":")
                if not separator:
                    raise ValueError("malformed LSP header")
                key = name.strip().lower()
                if key == "content-length":
                    if key in headers:
                        raise ValueError("duplicate Content-Length")
                    headers[key] = int(value.strip())
            length = headers.get("content-length")
            if length is None or length < 0 or length > 8 * 1024 * 1024:
                raise ValueError("missing or invalid Content-Length")
            body = read_exact(stream, length)
            messages.put(json.loads(body.decode("utf-8")))
    except BaseException as error:
        errors.put(error)


def send(stream, message):
    body = json.dumps(message, separators=(",", ":")).encode("utf-8")
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
    stream.flush()


def response(messages, errors, request_id, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not errors.empty():
            fail(str(errors.get()))
        try:
            message = messages.get(timeout=max(0.01, deadline - time.monotonic()))
        except queue.Empty:
            break
        if message.get("id") == request_id and ("result" in message or "error" in message):
            if "error" in message:
                fail(f"request {request_id} returned {message['error']}")
            return message
        # Notifications and server-initiated requests are valid during startup.
    fail(f"timed out waiting for response to request {request_id}")


def main():
    executable = shutil.which("rust-analyzer")
    if not executable:
        fail("rust-analyzer was not found on PATH")

    version = subprocess.run(
        [executable, "--version"], check=True, capture_output=True, text=True, timeout=15
    )
    print(version.stdout.strip() or version.stderr.strip())

    with tempfile.TemporaryDirectory(prefix="gocode-rust-analyzer-") as directory:
        root = Path(directory)
        (root / "Cargo.toml").write_text(
            '[package]\nname = "lsp_smoke"\nversion = "0.1.0"\nedition = "2021"\n',
            encoding="utf-8",
        )
        (root / "src").mkdir()
        (root / "src" / "main.rs").write_text("fn main() { let answer: u32 = 42; }\n", encoding="utf-8")
        root_uri = root.resolve().as_uri()

        process = subprocess.Popen(
            [executable],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        messages = queue.Queue()
        errors = queue.Queue()
        thread = threading.Thread(target=reader, args=(process.stdout, messages, errors), daemon=True)
        thread.start()
        try:
            send(process.stdin, {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "processId": os.getpid(),
                    "clientInfo": {"name": "Gocode IDE CI", "version": "0.1.0"},
                    "rootUri": root_uri,
                    "rootPath": str(root),
                    "workspaceFolders": [{"uri": root_uri, "name": "lsp_smoke"}],
                    "capabilities": {
                        "workspace": {
                            "applyEdit": True,
                            "workspaceFolders": True,
                            "configuration": True,
                            "didChangeConfiguration": {"dynamicRegistration": True},
                        },
                        "textDocument": {
                            "publishDiagnostics": {"relatedInformation": True},
                            "completion": {"completionItem": {"snippetSupport": True}},
                        },
                    },
                },
            })
            initialized = response(messages, errors, 1, 90)
            capabilities = initialized.get("result", {}).get("capabilities")
            if not isinstance(capabilities, dict):
                fail("initialize response did not contain server capabilities")
            print("initialize: passed")

            send(process.stdin, {"jsonrpc": "2.0", "method": "initialized", "params": {}})
            send(process.stdin, {"jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": None})
            response(messages, errors, 2, 30)
            print("shutdown: passed")
            send(process.stdin, {"jsonrpc": "2.0", "method": "exit"})
            process.stdin.close()
            try:
                code = process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                fail("server did not exit after the LSP exit notification")
            if code != 0:
                fail(f"server exited with code {code}")
            print("rust-analyzer real-process LSP smoke test passed")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
