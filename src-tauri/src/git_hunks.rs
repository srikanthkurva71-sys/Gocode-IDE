pub const MAX_GIT_HUNK_PATCH_BYTES: usize = 1_000_000;

pub fn validate_hunk_patch(patch: &str) -> Result<(), String> {
    if patch.is_empty()
        || patch.len() > MAX_GIT_HUNK_PATCH_BYTES
        || patch.contains('\0')
        || !patch.starts_with("diff --git ")
        || !patch.contains("\n@@ ")
    {
        return Err("Invalid or oversized Git hunk patch.".into());
    }
    Ok(())
}

pub fn apply_args(action: &str) -> Result<&'static [&'static str], String> {
    match action {
        "stage" => Ok(&["apply", "--cached", "--whitespace=nowarn", "-"]),
        "unstage" => Ok(&["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"]),
        "discard" => Ok(&["apply", "--reverse", "--whitespace=nowarn", "-"]),
        _ => Err("Unsupported Git hunk action.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{apply_args, validate_hunk_patch, MAX_GIT_HUNK_PATCH_BYTES};

    const PATCH: &str = "diff --git a/file.txt b/file.txt\nindex 1111111..2222222 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";

    #[test]
    fn accepts_bounded_unified_hunk_patch() {
        assert!(validate_hunk_patch(PATCH).is_ok());
    }

    #[test]
    fn rejects_empty_malformed_and_oversized_patches() {
        assert!(validate_hunk_patch("").is_err());
        assert!(validate_hunk_patch("not a diff").is_err());
        assert!(validate_hunk_patch("diff --git a/a b/a\nno hunk\n").is_err());
        let oversized = format!("diff --git a/a b/a\n@@ -1 +1 @@\n{}", "x".repeat(MAX_GIT_HUNK_PATCH_BYTES));
        assert!(validate_hunk_patch(&oversized).is_err());
    }

    #[test]
    fn rejects_null_bytes() {
        let patch = PATCH.replace("+new", "+ne\0w");
        assert!(validate_hunk_patch(&patch).is_err());
    }

    #[test]
    fn exposes_only_the_three_supported_apply_modes() {
        assert_eq!(apply_args("stage").unwrap(), &["apply", "--cached", "--whitespace=nowarn", "-"]);
        assert_eq!(apply_args("unstage").unwrap(), &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"]);
        assert_eq!(apply_args("discard").unwrap(), &["apply", "--reverse", "--whitespace=nowarn", "-"]);
        assert!(apply_args("reset-hard").is_err());
    }
    fn run_git(root: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("Git must be installed for the hunk integration test");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn stage_unstage_and_discard_change_only_the_selected_working_diff() {
        use std::{
            fs,
            io::Write,
            process::Stdio,
            time::{SystemTime, UNIX_EPOCH},
        };

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-git-hunk-test-{unique}"));
        fs::create_dir_all(&root).unwrap();

        run_git(&root, &["init", "-q"]);
        run_git(&root, &["config", "user.name", "Gocode IDE Tests"]);
        run_git(&root, &["config", "user.email", "gocode-tests@example.invalid"]);
        let file = root.join("sample.txt");
        fs::write(&file, "first\noriginal\nlast\n").unwrap();
        run_git(&root, &["add", "sample.txt"]);
        run_git(&root, &["commit", "-q", "-m", "initial"]);

        fs::write(&file, "first\nmodified\nlast\n").unwrap();
        let patch = run_git(&root, &["diff", "--", "sample.txt"]);
        validate_hunk_patch(&patch).unwrap();

        let apply = |action: &str, patch: &str| {
            let args = apply_args(action).unwrap();
            let mut child = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(patch.as_bytes()).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "git apply {action} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };

        apply("stage", &patch);
        assert!(run_git(&root, &["diff", "--cached"]).contains("+modified"));
        assert!(run_git(&root, &["diff"]).is_empty());

        // Recreate an unstaged change, then verify unstage leaves the worktree intact.
        run_git(&root, &["reset", "-q", "HEAD"]);
        assert!(run_git(&root, &["diff"]).contains("+modified"));
        apply("stage", &patch);
        apply("unstage", &patch);
        assert!(run_git(&root, &["diff", "--cached"]).is_empty());
        assert!(run_git(&root, &["diff"]).contains("+modified"));

        apply("discard", &patch);
        assert!(run_git(&root, &["diff"]).is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "first\noriginal\nlast\n");

        fs::remove_dir_all(root).unwrap();
    }

}
