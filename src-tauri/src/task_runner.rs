use serde::Serialize;
use std::{
    io::{self, Read},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
    sync::{Arc, Mutex},
    thread,
};

/// Stable result contract shared by run-file and project-task execution.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TaskResult {
    pub command: String,
    pub success: bool,
    pub output: String,
    pub timed_out: bool,
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

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child) {
    // taskkill /T terminates descendants as well as the directly spawned process.
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .status();
    let _ = child.kill();
}

#[cfg(not(windows))]
fn terminate_process_tree(child: &mut Child) {
    // Unix process-group isolation is a separate platform integration; at minimum
    // always terminate and reap the directly spawned process on timeout.
    #[cfg(unix)]
    {
        // Each task is spawned in its own process group, so grandchildren that
        // inherited stdout/stderr cannot keep the reader threads alive.
        let process_group = -(child.id() as libc::pid_t);
        // SAFETY: the process group was created for this child immediately before
        // spawn; sending SIGKILL to its negative PID targets only that task tree.
        unsafe { libc::kill(process_group, libc::SIGKILL); }
    }
    let _ = child.kill();
}

/// Stream stdout/stderr into a bounded buffer and enforce a wall-clock timeout.
/// On Windows, timeout termination also targets the process' descendant tree.
pub fn run_bounded_command(
    command: &mut Command,
    max_bytes: usize,
    timeout: Duration,
) -> io::Result<(ExitStatus, String, bool)> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "stdout pipe unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "stderr pipe unavailable"))?;
    let capture = Arc::new(Mutex::new(OutputCapture::default()));
    let stdout_reader = capture_reader(stdout, Arc::clone(&capture), max_bytes);
    let stderr_reader = capture_reader(stderr, Arc::clone(&capture), max_bytes);

    let started = Instant::now();
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            // A child may exit while a descendant still holds inherited stdout or
            // stderr handles. Terminate any remaining members of this task's
            // isolated process group before joining the pipe readers.
            #[cfg(unix)]
            {
                let process_group = -(child.id() as libc::pid_t);
                // SAFETY: this process group was created exclusively for this
                // command via CommandExt::process_group(0) before spawning it.
                unsafe { libc::kill(process_group, libc::SIGKILL); }
            }
            break (status, false);
        }
        if started.elapsed() >= timeout {
            terminate_process_tree(&mut child);
            break (child.wait()?, true);
        }
        thread::sleep(Duration::from_millis(20));
    };

    stdout_reader.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "stdout reader panicked"))??;
    stderr_reader.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "stderr reader panicked"))??;

    let output = capture.lock().map_err(|_| io::Error::new(io::ErrorKind::Other, "output capture unavailable"))?;
    let mut text = String::from_utf8_lossy(&output.bytes).into_owned();
    if output.truncated { text.push_str("\n[Output truncated]"); }
    if timed_out { text.push_str("\n[Process timed out and was terminated]"); }
    Ok((status, text, timed_out))
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
        let (status, output, timed_out) = run_bounded_command(&mut command, 5, Duration::from_secs(2)).unwrap();
        assert!(!timed_out);
        assert!(status.success());
        assert!(output.starts_with("12345"));
        assert!(output.ends_with("[Output truncated]"));
    }

    #[cfg(unix)]
    #[test]
    fn streams_and_bounds_process_output_on_unix() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 123456789012345"]);
        let (status, output, timed_out) = run_bounded_command(&mut command, 5, Duration::from_secs(2)).unwrap();
        assert!(!timed_out);
        assert!(status.success());
        assert!(output.starts_with("12345"));
        assert!(output.ends_with("[Output truncated]"));
    }
    #[cfg(unix)]
    #[test]
    fn reaps_descendants_that_keep_output_pipes_open_after_parent_exit() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 10 & exit 0"]);
        let started = Instant::now();
        let (status, _output, timed_out) =
            run_bounded_command(&mut command, 1024, Duration::from_secs(3)).unwrap();
        assert!(status.success());
        assert!(!timed_out);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn terminates_a_command_after_timeout() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        let (status, output, timed_out) =
            run_bounded_command(&mut command, 1024, Duration::from_millis(100)).unwrap();
        assert!(timed_out);
        assert!(!status.success());
        assert!(output.contains("timed out"));
    }

    #[cfg(windows)]
    #[test]
    fn terminates_a_command_after_timeout() {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 5"]);
        let (status, output, timed_out) =
            run_bounded_command(&mut command, 1024, Duration::from_millis(100)).unwrap();
        assert!(timed_out);
        assert!(!status.success());
        assert!(output.contains("timed out"));
    }

}
