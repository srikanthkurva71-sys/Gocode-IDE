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
}
