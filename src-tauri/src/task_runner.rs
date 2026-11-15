use serde::Serialize;
use std::{
    io::{self, Read},
    process::{Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
};

/// Stable result contract shared by run-file and project-task execution.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TaskResult {
    pub command: String,
    pub success: bool,
    pub output: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskSpec {
    pub label: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
}

/// Resolve only known, fixed project tasks. Never interpret user input as a shell command.
pub fn resolve_project_task(label: &str) -> Option<TaskSpec> {
    const TASKS: &[TaskSpec] = &[
        TaskSpec { label: "npm run build", program: "npm", args: &["run", "build"] },
        TaskSpec { label: "npm test", program: "npm", args: &["test"] },
        TaskSpec { label: "cargo build", program: "cargo", args: &["build"] },
        TaskSpec { label: "cargo test", program: "cargo", args: &["test"] },
        TaskSpec { label: "python -m compileall .", program: "python", args: &["-m", "compileall", "."] },
        TaskSpec { label: "make", program: "make", args: &[] },
        TaskSpec { label: "go build ./...", program: "go", args: &["build", "./..."] },
        TaskSpec { label: "go test ./...", program: "go", args: &["test", "./..."] },
        TaskSpec { label: "cmake -S . -B build", program: "cmake", args: &["-S", ".", "-B", "build"] },
    ];
    TASKS.iter().copied().find(|task| task.label == label)
}

#[derive(Default)]
struct OutputCapture {
    bytes: Vec<u8>,
    truncated: bool,
}

fn capture_reader(
    mut reader: impl Read + Send + 'static,
    capture: Arc<Mutex<OutputCapture>>,
    max_bytes: usize,
) -> thread::JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        let mut chunk = [0_u8; 8192];
        loop {
            let count = reader.read(&mut chunk)?;
            if count == 0 { break; }
            if let Ok(mut output) = capture.lock() {
                let remaining = max_bytes.saturating_sub(output.bytes.len());
                let accepted = remaining.min(count);
                output.bytes.extend_from_slice(&chunk[..accepted]);
                if accepted < count { output.truncated = true; }
            }
            // Continue draining even after the display buffer is full so a child
            // cannot block on a full stdout or stderr pipe.
        }
        Ok(())
    })
}

/// Stream stdout and stderr concurrently into a bounded buffer. This caps memory
/// while the process runs; Command::output() would buffer all output before truncation.
pub fn run_bounded_command(command: &mut Command, max_bytes: usize) -> io::Result<(ExitStatus, String)> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "stdout pipe unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "stderr pipe unavailable"))?;
    let capture = Arc::new(Mutex::new(OutputCapture::default()));
    let stdout_reader = capture_reader(stdout, Arc::clone(&capture), max_bytes);
    let stderr_reader = capture_reader(stderr, Arc::clone(&capture), max_bytes);

    let status = child.wait()?;
    stdout_reader.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "stdout reader panicked"))??;
    stderr_reader.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "stderr reader panicked"))??;

    let output = capture.lock().map_err(|_| io::Error::new(io::ErrorKind::Other, "output capture unavailable"))?;
    let mut text = String::from_utf8_lossy(&output.bytes).into_owned();
    if output.truncated { text.push_str("\n[Output truncated]"); }
    Ok((status, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_only_allowlisted_tasks() {
        let task = resolve_project_task("cargo test").unwrap();
        assert_eq!(task.program, "cargo");
        assert_eq!(task.args, &["test"]);
        assert_eq!(task.label, "cargo test");
    }

    #[test]
    fn rejects_arbitrary_shell_input() {
        for input in [
            "cargo test; whoami",
            "npm run build && curl example.invalid",
            "powershell.exe -Command whoami",
            "",
            " cargo test",
            "cargo test ",
        ] {
            assert!(resolve_project_task(input).is_none(), "unexpectedly accepted: {input}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn streams_and_bounds_process_output_on_windows() {
        let mut command = Command::new("cmd.exe");
        command.args(["/C", "echo 123456789012345"]);
        let (status, output) = run_bounded_command(&mut command, 5).unwrap();
        assert!(status.success());
        assert!(output.starts_with("12345"));
        assert!(output.ends_with("[Output truncated]"));
    }

    #[cfg(unix)]
    #[test]
    fn streams_and_bounds_process_output_on_unix() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 123456789012345"]);
        let (status, output) = run_bounded_command(&mut command, 5).unwrap();
        assert!(status.success());
        assert!(output.starts_with("12345"));
        assert!(output.ends_with("[Output truncated]"));
    }
}
