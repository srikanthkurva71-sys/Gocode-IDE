use std::{fs, path::{Path, PathBuf}};

/// Resolve a project-relative path while rejecting traversal and names that are
/// invalid or ambiguous on Windows. Filesystem containment is checked separately
/// after canonicalization and before writes.
pub fn safe_relative_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.is_empty()
        || relative.trim() != relative
        || relative.contains('\\')
        || relative.contains(':')
        || rel.is_absolute()
        || relative.split('/').any(|part| {
            let trimmed = part.trim_end_matches(['.', ' ']);
            let base = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with('.')
                || part.ends_with(' ')
                || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (base.len() == 4
                    && (base.starts_with("COM") || base.starts_with("LPT"))
                    && base.as_bytes()[3].is_ascii_digit()
                    && base.as_bytes()[3] != b'0')
        })
        || rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)))
    {
        return Err("Path must be a valid relative file path inside the opened project.".into());
    }
    Ok(root.join(rel))
}

/// Create missing parent directories without following symlinks or allowing a
/// canonical path to escape the opened project root.
pub fn ensure_safe_parent_directories(root: &Path, parent: &Path) -> Result<(), String> {
    let relative = parent.strip_prefix(root)
        .map_err(|_| "File is outside the opened project.".to_string())?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|e| format!("Cannot verify project root: {e}"))?;
    let mut current = canonical_root.clone();

    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err("Invalid project directory path.".into());
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("Refusing to write through a symbolic link or non-directory.".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|e| format!("Cannot create project directory: {e}"))?;
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|e| format!("Cannot verify project directory: {e}"))?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("Refusing to write through a symbolic link or non-directory.".into());
                }
            }
            Err(error) => return Err(format!("Cannot inspect project directory: {error}")),
        }

        let canonical = fs::canonicalize(&current)
            .map_err(|e| format!("Cannot verify project directory: {e}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("File is outside the opened project.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ensure_safe_parent_directories, safe_relative_path};
    use std::path::Path;

    #[test]
    fn creates_nested_project_directories_safely() {
        use std::{fs, time::{SystemTime, UNIX_EPOCH}};

        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-parent-test-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let parent = root.join("src").join("nested");
        ensure_safe_parent_directories(&root, &parent).unwrap();
        assert!(parent.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_project_parent_directories() {
        use std::{fs, os::unix::fs::symlink, time::{SystemTime, UNIX_EPOCH}};

        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-parent-test-{unique}"));
        let outside = std::env::temp_dir().join(format!("gocode-outside-test-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("linked")).unwrap();

        assert!(ensure_safe_parent_directories(&root, &root.join("linked").join("new")).is_err());
        assert!(!outside.join("new").exists());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn accepts_relative_project_file() {
        let result = safe_relative_path(Path::new("/tmp/project"), "src/main.rs").unwrap();
        assert!(result.ends_with("src/main.rs"));
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(safe_relative_path(Path::new("/tmp/project"), "../outside.txt").is_err());
        assert!(safe_relative_path(Path::new("/tmp/project"), "src/../../outside.txt").is_err());
    }

    #[test]
    fn rejects_absolute_path() {
        assert!(safe_relative_path(Path::new("/tmp/project"), "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_cross_platform_invalid_file_names() {
        let root = Path::new("/tmp/project");
        for path in [
            "C:/Windows/secret.txt",
            "D:relative.txt",
            "src\\main.rs",
            "src//main.rs",
            "src/file:name.rs",
            "CON",
            "nul.txt",
            "folder/LPT1.log",
            "trailing-dot.",
            "trailing-space ",
            " leading-space.rs",
        ] {
            assert!(safe_relative_path(root, path).is_err(), "accepted invalid path: {path}");
        }
    }
}
