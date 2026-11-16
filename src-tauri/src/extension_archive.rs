//! ZIP package validation and bounded extraction into a private staging directory.
//!
//! This module never installs or executes extension code. A successful result is a
//! temporary staging directory plus a validated manifest for a later review step.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use serde::Deserialize;
use zip::{CompressionMethod, ZipArchive};

use crate::extension_archive_policy::{
    validate_archive_inventory, ArchiveEntryMetadata, MAX_ARCHIVE_ENTRIES,
    MAX_ENTRY_UNCOMPRESSED_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES,
};

const MAX_COMPRESSED_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MANIFEST_FILE_NAME: &str = "extension.json";

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExtensionPackageManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub license: String,
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

impl ExtensionPackageManifest {
    fn validate(&mut self) -> Result<(), String> {
        self.id = self.id.trim().to_string();
        self.name = self.name.trim().to_string();
        self.version = self.version.trim().to_string();
        self.publisher = self.publisher.trim().to_string();
        self.license = self.license.trim().to_string();
        self.description = self.description.trim().to_string();
        for (field, value) in [
            ("id", &self.id), ("name", &self.name), ("version", &self.version),
            ("publisher", &self.publisher), ("license", &self.license),
            ("description", &self.description),
        ] {
            if value.trim().is_empty() || value.len() > 500
                || value.chars().any(char::is_control)
            {
                return Err(format!("Extension manifest field '{field}' is empty or invalid."));
            }
        }
        if self.id.len() < 2 || self.id.len() > 80
            || !self.id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            || !self.id.as_bytes()[0].is_ascii_alphanumeric()
        {
            return Err("Extension manifest id must be 2–80 safe ASCII characters.".into());
        }
        semver::Version::parse(&self.version)
            .map_err(|_| "Extension manifest version must be valid semantic versioning.".to_string())?;
        if self.capabilities.len() > 32 {
            return Err("Extension manifest declares more than 32 capabilities.".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        for capability in &self.capabilities {
            if capability.is_empty() || capability.len() > 100
                || !capability.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
                || !capability.as_bytes()[0].is_ascii_lowercase()
                || capability.split(|character| matches!(character, '.' | '_' | '-')).any(|part| part.is_empty())
            {
                return Err("Extension manifest contains an invalid capability identifier.".into());
            }
            if !seen.insert(capability.clone()) {
                return Err("Extension manifest contains duplicate capability identifiers.".into());
            }
        }
        Ok(())
    }
}

/// Keeps the private staging directory alive while its contents are reviewed.
#[derive(Debug)]
pub(crate) struct StagedExtensionPackage {
    _directory: tempfile::TempDir,
    pub root: PathBuf,
    pub manifest: ExtensionPackageManifest,
    pub entry_count: usize,
    pub total_uncompressed_bytes: u64,
}

/// Parse, validate, and extract a package without installing or executing it.
pub(crate) fn stage_extension_archive(path: &Path) -> Result<StagedExtensionPackage, String> {
    let link_metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect extension archive: {e}"))?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file()
        || link_metadata.len() == 0 || link_metadata.len() > MAX_COMPRESSED_ARCHIVE_BYTES
    {
        return Err("Extension archive must be a regular file no larger than 20 MiB.".into());
    }

    let file = File::open(path).map_err(|e| format!("Cannot open extension archive: {e}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Invalid extension ZIP archive: {e}"))?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Extension archive has an invalid number of entries.".into());
    }
    if archive.has_duplicate_names() {
        return Err("Extension archive contains duplicate entry names.".into());
    }
    archive.validate_header_consistency()
        .map_err(|e| format!("Extension ZIP headers are inconsistent: {e}"))?;
    if archive.has_overlapping_entries()
        .map_err(|e| format!("Cannot validate ZIP entry boundaries: {e}"))?
    {
        return Err("Extension archive contains overlapping ZIP entries.".into());
    }

    // First pass: collect central-directory metadata and validate the complete
    // inventory before creating any filesystem entries.
    let mut raw_entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive.by_index(index)
            .map_err(|e| format!("Cannot inspect ZIP entry: {e}"))?;
        let name = entry.name().map_err(|e| format!("Invalid ZIP entry name: {e}"))?.into_owned();
        if entry.encrypted() {
            return Err("Encrypted extension archive entries are not supported.".into());
        }
        if entry.is_symlink() {
            return Err("Symbolic links are not permitted in extension packages.".into());
        }
        let mode_type = entry.unix_mode().unwrap_or(0) & 0o170000;
        if (mode_type != 0o000000 && mode_type != 0o100000 && mode_type != 0o040000)
            || (entry.is_dir() && mode_type == 0o100000)
            || (!entry.is_dir() && mode_type == 0o040000)
        {
            return Err("Extension archive contains a non-regular filesystem entry.".into());
        }
        if !matches!(entry.compression(), CompressionMethod::Stored | CompressionMethod::Deflated) {
            return Err("Extension archive uses an unsupported compression method.".into());
        }
        raw_entries.push((name, entry.compressed_size(), entry.size(), entry.is_dir(), entry.is_symlink(), entry.encrypted()));
    }
    let names: Vec<String> = raw_entries.iter().map(|entry| entry.0.clone()).collect();
    let inventory: Vec<ArchiveEntryMetadata<'_>> = raw_entries.iter().enumerate().map(|(i, entry)| ArchiveEntryMetadata {
        path: &names[i], compressed_size: entry.1, uncompressed_size: entry.2,
        is_directory: entry.3, is_symlink: entry.4, is_encrypted: entry.5,
    }).collect();
    let validation = validate_archive_inventory(&inventory)
        .map_err(|e| format!("Extension archive rejected: {e}"))?;
    if validation.total_uncompressed_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES {
        return Err("Extension archive exceeds the expanded-size limit.".into());
    }

    let staging = tempfile::Builder::new().prefix("gocode-extension-").tempdir()
        .map_err(|e| format!("Cannot create private extension staging directory: {e}"))?;
    let root = staging.path().to_path_buf();
    let mut actual_total = 0_u64;

    // Second pass: extract only regular files and empty directories. Never restore
    // archive permissions, timestamps, links, or executable bits.
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)
            .map_err(|e| format!("Cannot read ZIP entry: {e}"))?;
        let name = entry.name().map_err(|e| format!("Invalid ZIP entry name: {e}"))?.into_owned();
        let relative_text = if entry.is_dir() { name.strip_suffix('/').unwrap_or(&name) } else { name.as_str() };
        let relative = Path::new(relative_text);
        if relative.components().any(|component| !matches!(component, Component::Normal(_))) {
            return Err("Extension archive contains a non-relative path.".into());
        }
        let destination = root.join(relative);
        if entry.is_dir() {
            create_private_directories(&root, relative)?;
            continue;
        }
        if entry.size() > MAX_ENTRY_UNCOMPRESSED_BYTES {
            return Err("Extension archive entry exceeds the per-file expanded-size limit.".into());
        }
        if let Some(parent) = relative.parent() {
            create_private_directories(&root, parent)?;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut output = options.open(&destination)
            .map_err(|e| format!("Cannot safely create staged extension file: {e}"))?;
        let declared_size = entry.size();
        let mut written = 0_u64;
        let mut buffer = [0_u8; 8192];
        loop {
            let count = entry.read(&mut buffer)
                .map_err(|e| format!("Cannot decompress extension file: {e}"))?;
            if count == 0 { break; }
            written = written.checked_add(count as u64)
                .ok_or_else(|| "Extension entry size overflowed.".to_string())?;
            actual_total = actual_total.checked_add(count as u64)
                .ok_or_else(|| "Extension archive size overflowed.".to_string())?;
            if written > declared_size || written > MAX_ENTRY_UNCOMPRESSED_BYTES
                || actual_total > MAX_TOTAL_UNCOMPRESSED_BYTES
            {
                return Err("Extension archive expanded beyond its declared size limits.".into());
            }
            output.write_all(&buffer[..count])
                .map_err(|e| format!("Cannot write staged extension file: {e}"))?;
        }
        if written != declared_size {
            return Err("Extension archive entry size did not match its declared size.".into());
        }
        output.flush().map_err(|e| format!("Cannot flush staged extension file: {e}"))?;
    }

    let manifest_path = root.join(MANIFEST_FILE_NAME);
    let manifest_metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|_| "Extension package is missing its extension.json manifest.".to_string())?;
    if manifest_metadata.file_type().is_symlink() || !manifest_metadata.is_file()
        || manifest_metadata.len() == 0 || manifest_metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("Extension package manifest must be a regular JSON file no larger than 64 KiB.".into());
    }
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|e| format!("Cannot read extension manifest: {e}"))?;
    let mut manifest: ExtensionPackageManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Invalid extension manifest JSON: {e}"))?;
    manifest.validate()?;

    Ok(StagedExtensionPackage {
        _directory: staging,
        root,
        manifest,
        entry_count: validation.entry_count,
        total_uncompressed_bytes: validation.total_uncompressed_bytes,
    })
}

fn create_private_directories(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err("Invalid directory path in extension archive.".into());
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err("Staged extension path conflicts with a non-directory.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)
                    .map_err(|e| format!("Cannot create staged extension directory: {e}"))?;
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|e| format!("Cannot verify staged extension directory: {e}"))?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err("Refusing to follow a staged extension symbolic link.".into());
                }
            }
            Err(error) => return Err(format!("Cannot inspect staged extension directory: {error}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, io::Write};
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn package_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer.start_file(*name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn valid_manifest() -> &'static [u8] {
        br#"{"id":"sample.extension","name":"Sample Extension","version":"1.2.3","publisher":"Example","license":"MIT","description":"Test package","capabilities":["editor.read"]}"#
    }

    fn stage_bytes(bytes: &[u8]) -> Result<StagedExtensionPackage, String> {
        let temp = tempfile::NamedTempFile::new().unwrap();
        fs::write(temp.path(), bytes).unwrap();
        stage_extension_archive(temp.path())
    }

    #[test]
    fn extracts_a_valid_package_to_a_private_staging_directory() {
        let bytes = package_zip(&[(MANIFEST_FILE_NAME, valid_manifest()), ("src/main.js", b"export {};")]);
        let staged = stage_bytes(&bytes).unwrap();
        assert_eq!(staged.manifest.id, "sample.extension");
        assert_eq!(fs::read(staged.root.join("src/main.js")).unwrap(), b"export {};");
    }

    #[test]
    fn rejects_traversal_before_writing_any_package_files() {
        let bytes = package_zip(&[("../escape.txt", b"no"), (MANIFEST_FILE_NAME, valid_manifest())]);
        assert!(stage_bytes(&bytes).is_err());
    }

    #[test]
    fn rejects_unknown_manifest_fields_and_invalid_semver() {
        let unknown = br#"{"id":"sample.extension","name":"Sample","version":"1.0.0","publisher":"P","license":"MIT","description":"D","extra":true}"#;
        let bytes = package_zip(&[(MANIFEST_FILE_NAME, unknown)]);
        assert!(stage_bytes(&bytes).unwrap_err().contains("manifest JSON"));
        let invalid = br#"{"id":"sample.extension","name":"Sample","version":"01.0.0","publisher":"P","license":"MIT","description":"D"}"#;
        let bytes = package_zip(&[(MANIFEST_FILE_NAME, invalid)]);
        assert!(stage_bytes(&bytes).unwrap_err().contains("semantic versioning"));
    }

    #[test]
    fn rejects_windows_unsafe_and_unicode_archive_paths_before_extraction() {
        for path in [
            "CONIN$", "CONOUT$", "bad<name>.txt", "bad>name.txt",
            "bad|name.txt", "bad?name.txt", "bad*name.txt",
            "bad\"name.txt", "café.txt",
        ] {
            let bytes = package_zip(&[
                (MANIFEST_FILE_NAME, valid_manifest()),
                (path, b"must not be extracted"),
            ]);
            assert!(stage_bytes(&bytes).is_err(), "accepted unsafe archive path: {path}");
        }
    }

    #[test]
    fn rejects_case_colliding_archive_names_before_extraction() {
        let bytes = package_zip(&[
            (MANIFEST_FILE_NAME, valid_manifest()),
            ("assets/icon.png", b"first"),
            ("ASSETS/ICON.PNG", b"second"),
        ]);
        assert!(stage_bytes(&bytes).is_err());
    }

    #[test]
    fn rejects_manifest_identifiers_and_capabilities_outside_the_schema() {
        let invalid_id = br#"{"id":"../escape","name":"Sample","version":"1.0.0","publisher":"P","license":"MIT","description":"D"}"#;
        let bytes = package_zip(&[(MANIFEST_FILE_NAME, invalid_id)]);
        assert!(stage_bytes(&bytes).unwrap_err().contains("manifest id"));

        let invalid_capability = br#"{"id":"sample.extension","name":"Sample","version":"1.0.0","publisher":"P","license":"MIT","description":"D","capabilities":["editor.*"]}"#;
        let bytes = package_zip(&[(MANIFEST_FILE_NAME, invalid_capability)]);
        assert!(stage_bytes(&bytes).unwrap_err().contains("invalid capability"));
    }

    #[test]
    fn rejects_manifest_control_characters_and_excessive_capability_count() {
        let control = br#"{"id":"sample.extension","name":"Sample\\nName","version":"1.0.0","publisher":"P","license":"MIT","description":"D"}"#;
        let bytes = package_zip(&[(MANIFEST_FILE_NAME, control)]);
        assert!(stage_bytes(&bytes).unwrap_err().contains("empty or invalid"));

        let capabilities = (0..33).map(|i| format!("\"capability{i}\"")).collect::<Vec<_>>().join(",");
        let manifest = format!(
            "{{\"id\":\"sample.extension\",\"name\":\"Sample\",\"version\":\"1.0.0\",\"publisher\":\"P\",\"license\":\"MIT\",\"description\":\"D\",\"capabilities\":[{capabilities}]}}"
        );
        let bytes = package_zip(&[(MANIFEST_FILE_NAME, manifest.as_bytes())]);
        assert!(stage_bytes(&bytes).unwrap_err().contains("more than 32"));
    }

    #[test]
    fn rejects_non_zip_and_oversized_compressed_input() {
        assert!(stage_bytes(b"not a zip archive").is_err());
        let temp = tempfile::NamedTempFile::new().unwrap();
        let too_large = vec![0_u8; (MAX_COMPRESSED_ARCHIVE_BYTES + 1) as usize];
        fs::write(temp.path(), too_large).unwrap();
        assert!(stage_extension_archive(temp.path()).is_err());
    }
}
