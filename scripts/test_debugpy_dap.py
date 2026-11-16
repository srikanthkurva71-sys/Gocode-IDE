#!/usr/bin/env python3
"""Exercise a real debugpy DAP adapter through launch, inspection and shutdown."""
import json
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def fail(message):
    raise SystemExit(f"debugpy DAP smoke test failed: {message}")


def read_exact(stream, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("truncated DAP message")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def reader(stream, messages, errors):
    try:
        while True:
            headers = {}
            header_bytes = 0
            while True:
                line = stream.readline()
                if not line:
                    return
                header_bytes += len(line)
                if header_bytes > 16 * 1024:
                    raise ValueError("DAP headers exceeded 16 KiB")
                if line in (b"\r\n", b"\n"):
                    break
                name, separator, value = line.decode("ascii").partition(":")
                if not separator:
                    raise ValueError("malformed DAP header")
                key = name.strip().lower()
                if key == "content-length":
                    if key in headers:
                        raise ValueError("duplicate Content-Length")
                    headers[key] = int(value.strip())
            length = headers.get("content-length")
            if length is None or length < 0 or length > 8 * 1024 * 1024:
                raise ValueError("missing or invalid DAP Content-Length")
            messages.put(json.loads(read_exact(stream, length).decode("utf-8")))
    except BaseException as error:
        errors.put(error)


def send(stream, message):
    body = json.dumps(message, separators=(",", ":")).encode("utf-8")
    stream.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
    stream.flush()


class DapClient:
    def __init__(self, process):
        self.process = process
        self.messages = queue.Queue()
        self.errors = queue.Queue()
        self.seq = 1
        self.thread = threading.Thread(
            target=reader,
            args=(process.stdout, self.messages, self.errors),
            daemon=True,
        )
        self.thread.start()

    def begin_request(self, command, arguments=None):
        request_seq = self.seq
        self.seq += 1
        send(self.process.stdin, {
            "seq": request_seq,
            "type": "request",
            "command": command,
            "arguments": arguments or {},
        })
        return request_seq

    def wait_response(self, request_seq, command, timeout=45):
        deadline = time.monotonic() + timeout
        deferred = []
        try:
            while time.monotonic() < deadline:
                if not self.errors.empty():
                    fail(str(self.errors.get()))
                try:
                    item = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if item.get("type") == "response" and item.get("request_seq") == request_seq:
                    if not item.get("success"):
                        fail(f"{command} request failed: {item.get('message', item)}")
                    return item
                deferred.append(item)
            fail(f"timed out waiting for {command} response")
        finally:
            for item in deferred:
                self.messages.put(item)

    def request(self, command, arguments=None, timeout=45):
        request_seq = self.begin_request(command, arguments)
        return self.wait_response(request_seq, command, timeout)

    def wait_event(self, name, timeout=45):
        deadline = time.monotonic() + timeout
        deferred = []
        try:
            while time.monotonic() < deadline:
                if not self.errors.empty():
                    fail(str(self.errors.get()))
                try:
                    item = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if item.get("type") == "event" and item.get("event") == name:
                    return item
                deferred.append(item)
            fail(f"timed out waiting for {name} event")
        finally:
            for item in deferred:
                self.messages.put(item)


def main():
    if not shutil.which(sys.executable):
        fail("Python executable is unavailable")
    try:
        import debugpy
    except ImportError:
        fail("debugpy is not installed; install the pinned CI dependency")

    print(f"debugpy {debugpy.__version__}", flush=True)
    with tempfile.TemporaryDirectory(prefix="gocode-debugpy-") as directory:
        root = Path(directory)
        program = root / "debug_target.py"
        program.write_text(
            "import time\nvalue = 21\nprint(value * 2)\ntime.sleep(0.1)\n",
            encoding="utf-8",
        )
        process = subprocess.Popen(
            [sys.executable, "-u", "-m", "debugpy.adapter"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        client = DapClient(process)
        try:
            initialized = client.request("initialize", {
                "clientID": "gocode-ide-ci",
                "clientName": "Gocode IDE CI",
                "adapterID": "python",
                "pathFormat": "path",
                "linesStartAt1": True,
                "columnsStartAt1": True,
                "supportsRunInTerminalRequest": False,
                "supportsVariableType": True,
                "supportsVariablePaging": True,
            })
            capabilities = initialized.get("body", {})
            if not isinstance(capabilities, dict):
                fail("initialize response did not include adapter capabilities")
            print("initialize: passed", flush=True)

            launch_seq = client.begin_request("launch", {
                "noDebug": False,
                "program": str(program),
                "cwd": str(root),
                "console": "internalConsole",
                "stopOnEntry": True,
                "justMyCode": False,
                "redirectOutput": True,
            })
            # DAP launch may not respond until the client handles the
            # initialized event and sends configurationDone.
            client.wait_event("initialized", timeout=60)
            client.request("configurationDone", {}, timeout=30)
            client.wait_response(launch_seq, "launch", timeout=60)
            stopped = client.wait_event("stopped", timeout=60)
            if stopped.get("body", {}).get("reason") not in ("entry", "breakpoint", "pause"):
                fail(f"unexpected stop reason: {stopped.get('body', {})}")
            print("launch/configuration stop: passed", flush=True)

            threads = client.request("threads", {}, timeout=30).get("body", {}).get("threads", [])
            if not threads:
                fail("debug adapter returned no threads")
            thread_id = threads[0].get("id")
            if not isinstance(thread_id, int):
                fail("debug adapter returned an invalid thread ID")
            print("threads: passed", flush=True)

            frames = client.request("stackTrace", {
                "threadId": thread_id,
                "startFrame": 0,
                "levels": 20,
            }, timeout=30).get("body", {}).get("stackFrames", [])
            if not frames:
                fail("debug adapter returned no stack frames")
            frame_id = frames[0].get("id")
            if not isinstance(frame_id, int):
                fail("debug adapter returned an invalid stack-frame ID")
            print("stackTrace: passed", flush=True)

            scopes = client.request("scopes", {"frameId": frame_id}, timeout=30)
            scope_list = scopes.get("body", {}).get("scopes", [])
            if not isinstance(scope_list, list):
                fail("debug adapter returned malformed scopes")
            print("scopes: passed", flush=True)

            client.request("continue", {"threadId": thread_id}, timeout=30)
            client.wait_event("terminated", timeout=60)
            print("continue/terminated: passed", flush=True)

            client.request("disconnect", {"restart": False, "terminateDebuggee": True}, timeout=30)
            process.stdin.close()
            try:
                exit_code = process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                fail("debugpy adapter did not exit after disconnect")
            if exit_code != 0:
                fail(f"debugpy adapter exited with code {exit_code}")
            print("disconnect: passed", flush=True)
            print("real debugpy DAP interoperability smoke test passed", flush=True)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
