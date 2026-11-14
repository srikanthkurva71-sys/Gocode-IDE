use serde::Serialize;

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

/// Bound captured process output so a noisy build cannot grow IDE memory indefinitely.
pub fn bounded_output(stdout: &[u8], stderr: &[u8], max_bytes: usize) -> String {
    let mut output = String::from_utf8_lossy(stdout).into_owned();
    output.push_str(&String::from_utf8_lossy(stderr));
    if output.len() > max_bytes {
        let mut boundary = max_bytes.min(output.len());
        while !output.is_char_boundary(boundary) { boundary -= 1; }
        output.truncate(boundary);
        output.push_str("\n[Output truncated]");
    }
    output
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

    #[test]
    fn output_is_bounded_and_marked() {
        let output = bounded_output(b"12345", b"67890", 7);
        assert!(output.len() > 7);
        assert!(output.starts_with("12345"));
        assert!(output.ends_with("[Output truncated]"));
    }

    #[test]
    fn output_preserves_utf8_boundaries() {
        let output = bounded_output("ééé".as_bytes(), b"", 3);
        assert!(output.is_char_boundary(output.find("\n[Output").unwrap()));
        assert!(output.ends_with("[Output truncated]"));
    }
}
