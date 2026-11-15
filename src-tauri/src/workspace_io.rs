use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineEnding { Lf, CrLf, Cr }

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProjectTextFormat { pub bom: bool, pub line_ending: LineEnding }

impl Default for ProjectTextFormat {
    fn default() -> Self { Self { bom: false, line_ending: LineEnding::Lf } }
}

#[derive(Debug, serde::Serialize)]
pub struct ProjectFileRead { pub content: String, pub format: ProjectTextFormat }

pub fn decode_project_text(bytes: &[u8]) -> io::Result<ProjectFileRead> {
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if bom { &bytes[3..] } else { bytes };
    let decoded = std::str::from_utf8(body)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("file is not valid UTF-8: {error}")))?;
    let crlf = decoded.matches("\r\n").count();
    let without_crlf = decoded.replace("\r\n", "");
    let lone_lf = without_crlf.matches('\n').count();
    let lone_cr = without_crlf.matches('\r').count();
    let line_ending = if crlf >= lone_lf && crlf >= lone_cr && crlf > 0 {
        LineEnding::CrLf
    } else if lone_cr > lone_lf && lone_cr > 0 {
        LineEnding::Cr
    } else { LineEnding::Lf };
    let content = decoded.replace("\r\n", "\n").replace('\r', "\n");
    Ok(ProjectFileRead { content, format: ProjectTextFormat { bom, line_ending } })
}

pub fn encode_project_text(content: &str, format: ProjectTextFormat) -> Vec<u8> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let newline = match format.line_ending { LineEnding::Lf => "\n", LineEnding::CrLf => "\r\n", LineEnding::Cr => "\r" };
    let mut bytes = Vec::with_capacity(normalized.len() + if format.bom { 3 } else { 0 });
    if format.bom { bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]); }
    for (index, part) in normalized.split('\n').enumerate() {
        if index > 0 { bytes.extend_from_slice(newline.as_bytes()); }
        bytes.extend_from_slice(part.as_bytes());
    }
    bytes
}


/// Refuse to overwrite a file that changed on disk since the editor loaded it.
/// A missing baseline is valid only when the target does not exist yet.
pub fn verify_expected_contents(target: &Path, expected: Option<&str>) -> io::Result<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to save through a symbolic link"));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "target is not a regular file"));
        }
        Ok(_) => {
            let Some(expected) = expected else {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, "file already exists and has no saved baseline"));
            };
            let current_bytes = fs::read(target)?;
            let current = decode_project_text(&current_bytes)?.content;
            if current != expected {
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, "file changed on disk since it was opened; reload or compare before saving"));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if expected.is_some() {
                return Err(io::Error::new(io::ErrorKind::NotFound, "file was deleted or moved since it was opened"));
            }
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

/// Write a sibling temporary file and atomically rename it over the target.
/// Keeping the temporary file in the same directory keeps the rename on one volume.
pub fn atomic_write_file(target: &Path, content: &[u8]) -> io::Result<()> {
    let parent = target.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no parent directory"))?;
    let name = target.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no file name"))?;
    let existing_permissions = match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to replace a symbolic link"));
        }
        Ok(metadata) if metadata.is_file() => Some(metadata.permissions()),
        Ok(_) => return Err(io::Error::new(io::ErrorKind::InvalidInput, "target is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };

    let mut temporary_path = None;
    let mut temporary_file = None;
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary_name = format!(
            ".{}.gocode-{}-{}.tmp",
            name.to_string_lossy(),
            std::process::id(),
            sequence
        );
        let candidate = parent.join(temporary_name);
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => {
                temporary_path = Some(candidate);
                temporary_file = Some(file);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    let temporary_path = temporary_path.ok_or_else(|| {
        io::Error::new(io::ErrorKind::AlreadyExists, "could not allocate a unique temporary file")
    })?;
    let result = (|| {
        let mut file = temporary_file.expect("temporary file is created with its path");
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);

        if let Some(permissions) = existing_permissions {
            fs::set_permissions(&temporary_path, permissions)?;
        }
        fs::rename(&temporary_path, target)?;

        #[cfg(unix)]
        if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("gocode-workspace-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }


    #[test]
    fn decodes_and_reencodes_utf8_bom_and_crlf_without_loss() {
        let original = b"\xEF\xBB\xBFalpha\r\nbeta\r\n";
        let decoded = decode_project_text(original).unwrap();
        assert_eq!(decoded.content, "alpha\nbeta\n");
        assert_eq!(decoded.format, ProjectTextFormat { bom: true, line_ending: LineEnding::CrLf });
        assert_eq!(encode_project_text(&decoded.content, decoded.format), original);
    }

    #[test]
    fn preserves_lf_and_classic_mac_cr_line_endings() {
        for (bytes, ending) in [(b"one\ntwo\n".as_slice(), LineEnding::Lf), (b"one\rtwo\r".as_slice(), LineEnding::Cr)] {
            let decoded = decode_project_text(bytes).unwrap();
            assert_eq!(decoded.format.line_ending, ending);
            assert_eq!(encode_project_text(&decoded.content, decoded.format), bytes);
        }
    }

    #[test]
    fn rejects_non_utf8_text_instead_of_corrupting_it() {
        assert_eq!(decode_project_text(&[0xFF, 0xFE, 0x00]).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_external_modification_since_open() {
        let directory = test_directory();
        let target = directory.join("shared.txt");
        fs::write(&target, "external version").unwrap();
        let error = verify_expected_contents(&target, Some("editor's old version")).unwrap_err();
        assert!(error.to_string().contains("changed on disk"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn permits_save_when_disk_matches_saved_baseline() {
        let directory = test_directory();
        let target = directory.join("same.txt");
        fs::write(&target, "same content").unwrap();
        verify_expected_contents(&target, Some("same content")).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn refuses_to_overwrite_existing_file_without_baseline() {
        let directory = test_directory();
        let target = directory.join("already-there.txt");
        fs::write(&target, "keep me").unwrap();
        assert!(verify_expected_contents(&target, None).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep me");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn creates_file_without_exposing_partial_contents() {
        let directory = test_directory();
        let target = directory.join("new.txt");
        atomic_write_file(&target, b"complete contents").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"complete contents");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn replaces_existing_file_contents() {
        let directory = test_directory();
        let target = directory.join("existing.txt");
        fs::write(&target, b"old contents").unwrap();
        atomic_write_file(&target, b"new contents").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new contents");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_replace_a_symlink() {
        use std::os::unix::fs::symlink;
        let directory = test_directory();
        let outside = directory.join("outside.txt");
        let link = directory.join("link.txt");
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, &link).unwrap();
        assert!(atomic_write_file(&link, b"changed").is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        fs::remove_dir_all(directory).unwrap();
    }
}
