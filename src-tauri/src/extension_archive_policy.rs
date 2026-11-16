//! Conservative validation policy for untrusted extension archive entries.
//!
//! This module validates metadata supplied by a future archive reader. It does not
//! parse ZIP files, extract entries, install packages, or execute extension code.

use std::collections::BTreeSet;

pub const MAX_ARCHIVE_ENTRIES: usize = 2_048;
pub const MAX_ENTRY_UNCOMPRESSED_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_COMPRESSION_RATIO: u64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntryMetadata<'a> {
    pub path: &'a str,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_encrypted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveValidation {
    pub entry_count: usize,
    pub total_uncompressed_bytes: u64,
}

/// Validate one archive member using Windows-safe, slash-separated relative paths.
pub fn validate_archive_path(path: &str, is_directory: bool) -> Result<String, &'static str> {
    if path.is_empty() || path.len() > 240 || path.trim() != path {
        return Err("Archive entry path is empty, padded, or too long.");
    }
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\\')
        || path.contains(':') || path.chars().any(char::is_control)
    {
        return Err("Archive entry path must be a safe relative path.");
    }

    let normalized = if is_directory { path.strip_suffix('/').unwrap_or(path) } else { path };
    if normalized.is_empty() || normalized.ends_with('/') {
        return Err("Archive entry path has an invalid directory suffix.");
    }

    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".."
            || component.ends_with('.') || component.ends_with(' ')
        {
            return Err("Archive entry path contains an unsafe component.");
        }
        let base = component.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && base.as_bytes()[3].is_ascii_digit()
                && base.as_bytes()[3] != b'0')
        {
            return Err("Archive entry path uses a reserved Windows device name.");
        }
    }
    Ok(normalized.to_ascii_lowercase())
}

/// Validate a complete archive inventory before any extraction is attempted.
/// The caller must obtain metadata from a trusted ZIP parser and must still extract
/// into a fresh private staging directory with no symlink following.
pub fn validate_archive_inventory(
    entries: &[ArchiveEntryMetadata<'_>],
) -> Result<ArchiveValidation, &'static str> {
    if entries.is_empty() || entries.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Extension archive has an invalid number of entries.");
    }

    let mut seen = BTreeSet::new();
    let mut file_paths = BTreeSet::new();
    let mut total = 0_u64;

    for entry in entries {
        let normalized = validate_archive_path(entry.path, entry.is_directory)?;
        if !seen.insert(normalized.clone()) {
            return Err("Extension archive contains duplicate or case-colliding paths.");
        }
        if entry.is_symlink {
            return Err("Symbolic links are not permitted in extension packages.");
        }
        if entry.is_encrypted {
            return Err("Encrypted archive entries are not supported.");
        }
        if entry.is_directory {
            if entry.uncompressed_size != 0 || entry.compressed_size != 0 {
                return Err("Directory entries must not contain file data.");
            }
        } else {
            if entry.uncompressed_size > MAX_ENTRY_UNCOMPRESSED_BYTES {
                return Err("An extension archive entry exceeds the 10 MiB limit.");
            }
            if entry.uncompressed_size > 0 && entry.compressed_size == 0 {
                return Err("Archive entry has an invalid compressed size.");
            }
            if entry.compressed_size > 0
                && entry.uncompressed_size / entry.compressed_size > MAX_COMPRESSION_RATIO
            {
                return Err("Archive entry exceeds the compression-ratio limit.");
            }
            total = total.checked_add(entry.uncompressed_size)
                .ok_or("Extension archive size overflowed.")?;
            if total > MAX_TOTAL_UNCOMPRESSED_BYTES {
                return Err("Extension archive exceeds the 50 MiB expanded-size limit.");
            }
            file_paths.insert(normalized);
        }
    }

    // A regular file cannot also be the parent directory of another member.
    for path in &seen {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if file_paths.contains(prefix) {
                return Err("Archive path conflicts with a regular file entry.");
            }
            parent = prefix;
        }
    }

    Ok(ArchiveValidation {
        entry_count: entries.len(),
        total_uncompressed_bytes: total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, compressed: u64, expanded: u64) -> ArchiveEntryMetadata<'_> {
        ArchiveEntryMetadata {
            path, compressed_size: compressed, uncompressed_size: expanded,
            is_directory: false, is_symlink: false, is_encrypted: false,
        }
    }

    #[test]
    fn accepts_a_small_safe_inventory() {
        let entries = [file("extension/package.json", 80, 120), file("extension/main.js", 100, 300)];
        let result = validate_archive_inventory(&entries).unwrap();
        assert_eq!(result.entry_count, 2);
        assert_eq!(result.total_uncompressed_bytes, 420);
    }

    #[test]
    fn rejects_traversal_absolute_and_windows_unsafe_paths() {
        for path in ["../outside", "a/../../outside", "/rooted", "C:/outside", "a\\b", "a//b", "a/./b", "CON.txt", "folder/LPT1.log", "trailing.", "trailing "] {
            assert!(validate_archive_path(path, false).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn rejects_duplicate_and_case_colliding_entries() {
        let entries = [file("bin/tool.exe", 10, 10), file("BIN/TOOL.EXE", 10, 10)];
        assert!(validate_archive_inventory(&entries).is_err());
    }

    #[test]
    fn rejects_symlinks_and_encrypted_members() {
        let mut entry = file("main.js", 10, 10);
        entry.is_symlink = true;
        assert!(validate_archive_inventory(&[entry]).is_err());
        let mut entry = file("main.js", 10, 10);
        entry.is_encrypted = true;
        assert!(validate_archive_inventory(&[entry]).is_err());
    }

    #[test]
    fn enforces_entry_count_and_per_file_and_total_limits() {
        let too_large = [file("large.bin", 1, MAX_ENTRY_UNCOMPRESSED_BYTES + 1)];
        assert!(validate_archive_inventory(&too_large).is_err());
        let many: Vec<_> = (0..=MAX_ARCHIVE_ENTRIES).map(|i| file(&"x", 1, 1)).collect();
        assert!(validate_archive_inventory(&many).is_err());
        let total = [file("a.bin", 1, 30 * 1024 * 1024), file("b.bin", 1, 21 * 1024 * 1024)];
        assert!(validate_archive_inventory(&total).is_err());
    }

    #[test]
    fn rejects_excessive_compression_ratio_and_zero_compressed_payload() {
        let bomb = [file("payload.bin", 1, MAX_COMPRESSION_RATIO * 2)];
        assert!(validate_archive_inventory(&bomb).is_err());
        let zero = [file("payload.bin", 0, 1)];
        assert!(validate_archive_inventory(&zero).is_err());
    }

    #[test]
    fn rejects_file_directory_prefix_conflicts() {
        let entries = [file("assets", 10, 10), file("assets/icon.png", 10, 10)];
        assert!(validate_archive_inventory(&entries).is_err());
    }

    #[test]
    fn permits_explicit_empty_directory_entries() {
        let directory = ArchiveEntryMetadata {
            path: "assets/", compressed_size: 0, uncompressed_size: 0,
            is_directory: true, is_symlink: false, is_encrypted: false,
        };
        assert!(validate_archive_inventory(&[directory]).is_ok());
    }
}
