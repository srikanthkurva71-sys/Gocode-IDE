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
    #[serde(default)]
    pub cancelled: bool,
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
        TaskSpec { label: "python3 -m compileall .", program: "python3", args: &["-m", "compileall", "."] },
        TaskSpec { label: "mvn test", program: "mvn", args: &["test"] },
        TaskSpec { label: "gradle test", program: "gradle", args: &["test"] },
        TaskSpec { label: "dotnet build", program: "dotnet", args: &["build"] },
        TaskSpec { label: "dotnet test", program: "dotnet", args: &["test"] },
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
    on_chunk: Arc<dyn Fn(String) + Send + Sync>,
) -> thread::JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        let mut chunk = [0_u8; 8192];
        loop {
            let count = reader.read(&mut chunk)?;
            if count == 0 { break; }
            on_chunk(String::from_utf8_lossy(&chunk[..count]).into_owned());
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
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> io::Result<Self> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                CreateJobObjectW, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JobObjectExtendedLimitInformation,
            },
        };

        // SAFETY: null attributes/name request an unnamed job with the default ACL.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }

        // KILL_ON_JOB_CLOSE makes the job handle an ownership boundary: closing it
        // terminates every process still associated with this task.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the structure pointer and size match the requested information class.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: handle was returned by CreateJobObjectW and is owned here.
            unsafe { CloseHandle(handle); }
            return Err(error);
        }
        Ok(Self { handle })
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        // SAFETY: Child owns a live process handle for the duration of this call.
        let assigned = unsafe {
            AssignProcessToJobObject(self.handle, child.as_raw_handle() as _)
        };
        if assigned == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn terminate(&self) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        // SAFETY: self.handle is a live job handle owned by this guard.
        let terminated = unsafe { TerminateJobObject(self.handle, 1) };
        if terminated == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        // SAFETY: this guard uniquely owns the handle returned by CreateJobObjectW.
        unsafe { CloseHandle(self.handle); }
    }
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child, job: &WindowsJob) {
    // The Job Object covers the complete assigned process tree. Keep taskkill as a
    // last-resort fallback if Windows refuses to terminate the job for some reason.
    if job.terminate().is_err() {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
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
fn run_bounded_command_impl(
    command: &mut Command,
    max_bytes: usize,
    timeout: Duration,
    cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    on_output: Arc<dyn Fn(String) + Send + Sync>,
) -> io::Result<(ExitStatus, String, bool, bool)> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    let process_tree = WindowsJob::new()?;

    let mut child = command.spawn()?;

    #[cfg(windows)]
    if let Err(error) = process_tree.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::new(
            error.kind(),
            format!("failed to assign task process to its Windows Job Object: {error}"),
        ));
    }
    let stdout = child.stdout.take().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "stdout pipe unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| io::Error::new(io::ErrorKind::Other, "stderr pipe unavailable"))?;
    let capture = Arc::new(Mutex::new(OutputCapture::default()));
    let stdout_reader = capture_reader(stdout, Arc::clone(&capture), max_bytes, Arc::clone(&on_output));
    let stderr_reader = capture_reader(stderr, Arc::clone(&capture), max_bytes, on_output);

    let started = Instant::now();
    let (status, timed_out, cancelled) = loop {
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
            #[cfg(windows)]
            {
                // The leader may exit while descendants still hold the pipe handles.
                // Terminate the assigned job before joining readers.
                let _ = process_tree.terminate();
            }
            break (status, false, false);
        }
        if cancel.as_ref().is_some_and(|token| token.load(std::sync::atomic::Ordering::Relaxed)) {
            #[cfg(windows)]
            terminate_process_tree(&mut child, &process_tree);
            #[cfg(not(windows))]
            terminate_process_tree(&mut child);
            break (child.wait()?, false, true);
        }
        if started.elapsed() >= timeout {
            #[cfg(windows)]
            terminate_process_tree(&mut child, &process_tree);
            #[cfg(not(windows))]
            terminate_process_tree(&mut child);
            break (child.wait()?, true, false);
        }
        thread::sleep(Duration::from_millis(20));
    };

    #[cfg(windows)]
    drop(process_tree);

    stdout_reader.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "stdout reader panicked"))??;
    stderr_reader.join().map_err(|_| io::Error::new(io::ErrorKind::Other, "stderr reader panicked"))??;

    let output = capture.lock().map_err(|_| io::Error::new(io::ErrorKind::Other, "output capture unavailable"))?;
    let mut text = String::from_utf8_lossy(&output.bytes).into_owned();
    if output.truncated { text.push_str("\n[Output truncated]"); }
    if timed_out { text.push_str("\n[Process timed out and was terminated]"); }
    if cancelled { text.push_str("\n[Process cancelled by user]"); }
    Ok((status, text, timed_out, cancelled))
}


/// Legacy bounded runner used by Run File and existing callers.
pub fn run_bounded_command(
    command: &mut Command,
    max_bytes: usize,
    timeout: Duration,
) -> io::Result<(ExitStatus, String, bool)> {
    let (status, output, timed_out, _cancelled) =
        run_bounded_command_impl(command, max_bytes, timeout, None, Arc::new(|_| {}))?;
    Ok((status, output, timed_out))
}

/// Cancellable runner for interactive project tasks. Output is delivered as UTF-8
/// chunks while the process is running; the bounded aggregate is still returned.
pub fn run_bounded_command_controlled(
    command: &mut Command,
    max_bytes: usize,
    timeout: Duration,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    on_output: Arc<dyn Fn(String) + Send + Sync>,
) -> io::Result<(ExitStatus, String, bool, bool)> {
    run_bounded_command_impl(command, max_bytes, timeout, Some(cancel), on_output)
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
    fn resolves_additional_fixed_toolchain_tasks() {
        for label in ["python3 -m compileall .", "mvn test", "gradle test", "dotnet build", "dotnet test"] {
            assert!(resolve_project_task(label).is_some(), "missing fixed task: {label}");
        }
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
    fn terminates_descendants_when_the_parent_exits() {
        use std::{fs, process};

        let marker = std::env::temp_dir().join(format!(
            "gocode-job-child-{}.txt",
            process::id()
        ));
        let _ = fs::remove_file(&marker);

        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru; [System.IO.File]::WriteAllText($env:GOCODE_JOB_CHILD_PID_FILE, [string]$p.Id); exit 0",
        ]);
        command.env("GOCODE_JOB_CHILD_PID_FILE", &marker);

        let (status, _output, timed_out) =
            run_bounded_command(&mut command, 4096, Duration::from_secs(15)).unwrap();
        assert!(status.success(), "parent process failed: {status:?}; captured output: {_output}");
        assert!(!timed_out);

        let child_pid: u32 = fs::read_to_string(&marker)
            .expect("parent should record descendant PID")
            .trim()
            .parse()
            .expect("descendant PID should be numeric");
        let _ = fs::remove_file(&marker);

        // Give the OS a short scheduling window to finish processing job termination.
        thread::sleep(Duration::from_millis(100));
        let probe = format!(
            "if (Get-Process -Id {child_pid} -ErrorAction SilentlyContinue) {{ exit 1 }} else {{ exit 0 }}"
        );
        let probe_status = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &probe])
            .status()
            .unwrap();
        assert!(
            probe_status.success(),
            "descendant process {child_pid} remained alive after its parent exited"
        );
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

    #[cfg(unix)]
    #[test]
    fn cancels_a_running_command_and_reaps_it() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&cancel);
        let trigger = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Relaxed);
        });
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 10"]);
        let (status, output, timed_out, cancelled) = run_bounded_command_controlled(
            &mut command, 1024, Duration::from_secs(3), cancel, Arc::new(|_| {})
        ).unwrap();
        trigger.join().unwrap();
        assert!(cancelled);
        assert!(!timed_out);
        assert!(!status.success());
        assert!(output.contains("cancelled"));
    }

    #[cfg(windows)]
    #[test]
    fn cancels_a_running_command_and_reaps_it() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&cancel);
        let trigger = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Relaxed);
        });
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 10"]);
        let (status, output, timed_out, cancelled) = run_bounded_command_controlled(
            &mut command, 1024, Duration::from_secs(3), cancel, Arc::new(|_| {})
        ).unwrap();
        trigger.join().unwrap();
        assert!(cancelled);
        assert!(!timed_out);
        assert!(!status.success());
        assert!(output.contains("cancelled"));
    }

}
