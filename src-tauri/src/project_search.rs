use serde::Serialize;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

fn ensure_project_search_current(generation: &AtomicU64, request_generation: u64) -> Result<(), String> {
    if generation.load(Ordering::Relaxed) == request_generation {
        Ok(())
    } else {
        Err("Project search cancelled.".into())
    }
}

#[derive(Serialize)]
pub struct ProjectSearchResult {
    path: String,
    line_number: usize,
    snippet: String,
}

fn bounded_snippet(line: &str, max_chars: usize) -> String {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let snippet: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{snippet}…")
    } else {
        snippet
    }
}

pub fn normalize_search_query(query: &str) -> Result<String, String> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("Enter text to search for.".into());
    }
    if normalized.len() > 200 {
        return Err("Search text must be 200 characters or fewer.".into());
    }
    Ok(normalized)
}

pub fn search_project_root(
    root: &Path,
    query: &str,
    generation: &AtomicU64,
    request_generation: u64,
) -> Result<Vec<ProjectSearchResult>, String> {
    let mut stack = vec![(root.to_path_buf(), String::new())];
    let mut results = Vec::new();
    let mut inspected_files = 0usize;
    let mut inspected_entries = 0usize;
    while let Some((directory, prefix)) = stack.pop() {
        ensure_project_search_current(generation, request_generation)?;
        let read = fs::read_dir(&directory)
            .map_err(|e| format!("Cannot read project directory: {e}"))?;
        for item in read.flatten() {
            ensure_project_search_current(generation, request_generation)?;
            inspected_entries += 1;
            if inspected_entries > 10000 { break; }
            let name = item.file_name().to_string_lossy().to_string();
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | ".venv" | "__pycache__") {
                continue;
            }
            let path = item.path();
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let metadata = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if inspected_files < 10000 { stack.push((path, relative)); }
                continue;
            }
            if !metadata.is_file() { continue; }
            inspected_files += 1;
            if inspected_files > 10000 { break; }
            if metadata.len() > 1_000_000 { continue; }
            let contents = match fs::read_to_string(&path) {
                Ok(contents) => contents,
                Err(_) => continue,
            };
            for (index, line) in contents.lines().enumerate() {
                ensure_project_search_current(generation, request_generation)?;
                if line.to_lowercase().contains(query) {
                    let snippet = bounded_snippet(line, 240);
                    results.push(ProjectSearchResult {
                        path: relative.clone(),
                        line_number: index + 1,
                        snippet,
                    });
                    if results.len() >= 200 {
                        ensure_project_search_current(generation, request_generation)?;
                        return Ok(results);
                    }
                }
            }
        }
        if inspected_files > 10000 || inspected_entries > 10000 { break; }
    }
    ensure_project_search_current(generation, request_generation)?;
    results.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()).then(a.line_number.cmp(&b.line_number)));
    Ok(results)
}


#[cfg(test)]
mod tests {
    use super::{normalize_search_query, search_project_root};
    use std::{path::Path, sync::atomic::AtomicU64};

    #[test]
    fn normalizes_search_query_case_and_whitespace() {
        assert_eq!(normalize_search_query("  HeLLo  ").unwrap(), "hello");
    }

    #[test]
    fn rejects_empty_search_query() {
        assert!(normalize_search_query("   ").is_err());
    }

    #[test]
    fn rejects_search_query_over_limit() {
        assert!(normalize_search_query(&"x".repeat(201)).is_err());
        assert!(normalize_search_query(&"x".repeat(200)).is_ok());
    }

    #[test]
    fn search_finds_case_insensitive_matches_with_line_numbers() {
        use super::search_project_root;
        use std::{fs, sync::atomic::AtomicU64, time::{SystemTime, UNIX_EPOCH}};

        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-search-test-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}\nlet TARGET = 1;\n").unwrap();
        let generation = AtomicU64::new(1);
        let results = search_project_root(&root, "target", &generation, 1).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "src/main.rs");
        assert_eq!(results[0].line_number, 2);
        assert!(results[0].snippet.contains("TARGET"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_skips_generated_directories() {
        use super::search_project_root;
        use std::{fs, sync::atomic::AtomicU64, time::{SystemTime, UNIX_EPOCH}};

        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-search-test-{unique}"));
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("hidden.txt"), "secretneedle").unwrap();
        let generation = AtomicU64::new(1);
        let results = search_project_root(&root, "secretneedle", &generation, 1).unwrap();
        assert!(results.is_empty());
        fs::remove_dir_all(root).unwrap();
    }



    #[test]
    fn long_unicode_snippets_are_truncated_without_panicking() {
        use super::search_project_root;
        use std::{fs, sync::atomic::AtomicU64, time::{SystemTime, UNIX_EPOCH}};

        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-search-unicode-test-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("unicode.txt"), format!("{} needle", "é".repeat(300))).unwrap();
        let generation = AtomicU64::new(1);
        let results = search_project_root(&root, "needle", &generation, 1).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].snippet.ends_with('…'));
        assert!(results[0].snippet.chars().count() <= 241);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_search_stops_before_reading_a_directory_when_cancelled() {
        use super::search_project_root;
        use std::sync::atomic::AtomicU64;

        let generation = AtomicU64::new(2);
        let result = search_project_root(
            Path::new("directory-that-must-not-be-read"),
            "needle",
            &generation,
            1,
        );
        assert!(matches!(result, Err(error) if error == "Project search cancelled."));
    }

}
