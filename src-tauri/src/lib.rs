mod extension_policy;
mod extension_archive_policy;
mod extension_archive;
mod lsp_protocol;
mod task_runner;
mod workspace_io;
mod git_hunks;
mod git_history;
mod workspace_paths;

use git_history::{parse_git_history, GitCommit};
use workspace_paths::{ensure_safe_parent_directories, safe_relative_path};
use task_runner::{resolve_project_task, resolve_python_executable, run_bounded_command, run_bounded_command_controlled, TaskResult};
use workspace_io::{atomic_write_file, decode_project_text, encode_project_text, verify_expected_contents, ProjectFileRead, ProjectTextFormat};

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, Child};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use extension_archive::{stage_extension_archive, ExtensionPackageManifest};

mod lsp;
mod dap;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Default)]
struct ProjectState {
    root: Mutex<Option<PathBuf>>,
}

#[derive(Default)]
struct ProjectSearchState {
    generation: Arc<AtomicU64>,
}

fn ensure_project_search_current(generation: &AtomicU64, request_generation: u64) -> Result<(), String> {
    if generation.load(Ordering::Relaxed) == request_generation {
        Ok(())
    } else {
        Err("Project search cancelled.".into())
    }
}

#[derive(Serialize)]
struct ProjectEntry {
    path: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
struct GitResult {
    available: bool,
    output: String,
    branch: String,
    dirty: bool,
}



fn project_root(state: &State<'_, ProjectState>) -> Result<PathBuf, String> {
    state.root.lock().map_err(|_| "Project state unavailable.".to_string())?
        .clone().ok_or_else(|| "Open a project folder first.".to_string())
}

#[tauri::command]
fn set_project_root(
    state: State<'_, ProjectState>,
    search_state: State<'_, ProjectSearchState>,
    path: String,
) -> Result<String, String> {
    let canonical = fs::canonicalize(&path).map_err(|e| format!("Cannot open project folder: {e}"))?;
    if !canonical.is_dir() { return Err("Selected project path is not a directory.".into()); }
    search_state.generation.fetch_add(1, Ordering::Relaxed);
    *state.root.lock().map_err(|_| "Project state unavailable.".to_string())? = Some(canonical.clone());
    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
fn get_project_root(state: State<'_, ProjectState>) -> Result<Option<String>, String> {
    Ok(state.root.lock().map_err(|_| "Project state unavailable.".to_string())?
        .as_ref().map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn list_project_files(state: State<'_, ProjectState>) -> Result<Vec<ProjectEntry>, String> {
    let root = project_root(&state)?;
    let mut entries = Vec::new();
    let mut stack = vec![(root.clone(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let read = fs::read_dir(&dir).map_err(|e| format!("Cannot read project directory: {e}"))?;
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | ".venv" | "__pycache__") { continue; }
            let path = item.path();
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            // Do not follow symlinks while enumerating a project. A linked directory may
            // point outside the workspace and otherwise expose unrelated files in Explorer.
            let link_meta = match fs::symlink_metadata(&path) { Ok(m) => m, Err(_) => continue };
            if link_meta.file_type().is_symlink() { continue; }
            let meta = link_meta;
            if meta.is_dir() {
                entries.push(ProjectEntry { path: relative.clone(), is_dir: true, size: 0 });
                if entries.len() < 10000 { stack.push((path, relative)); }
            } else if meta.is_file() {
                entries.push(ProjectEntry { path: relative, is_dir: false, size: meta.len() });
            }
            if entries.len() >= 10000 { break; }
        }
        if entries.len() >= 10000 { break; }
    }
    entries.sort_by(|a,b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(entries)
}

#[derive(Serialize)]
struct ProjectSearchResult {
    path: String,
    line_number: usize,
    snippet: String,
}

fn normalize_search_query(query: &str) -> Result<String, String> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("Enter text to search for.".into());
    }
    if normalized.len() > 200 {
        return Err("Search text must be 200 characters or fewer.".into());
    }
    Ok(normalized)
}

fn search_project_root(
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
                    let mut snippet = line.trim().to_string();
                    if snippet.len() > 240 {
                        snippet.truncate(240);
                        snippet.push('…');
                    }
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

#[tauri::command]
async fn search_project_files(
    state: State<'_, ProjectState>,
    search_state: State<'_, ProjectSearchState>,
    query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    let root = project_root(&state)?;
    let query = normalize_search_query(&query)?;
    let generation = Arc::clone(&search_state.generation);
    let request_generation = generation.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    drop(search_state);
    drop(state);

    tauri::async_runtime::spawn_blocking(move || {
        search_project_root(&root, &query, &generation, request_generation)
    })
    .await
    .map_err(|error| format!("Project search worker failed: {error}"))?
}

#[tauri::command]
fn cancel_project_search(search_state: State<'_, ProjectSearchState>) {
    search_state.generation.fetch_add(1, Ordering::Relaxed);
}

#[tauri::command]
fn read_project_file(state: State<'_, ProjectState>, path: String) -> Result<ProjectFileRead, String> {
    let root = project_root(&state)?;
    let target = safe_relative_path(&root, &path)?;
    let canonical = fs::canonicalize(&target).map_err(|e| format!("Cannot read file: {e}"))?;
    if !canonical.starts_with(&root) || !canonical.is_file() { return Err("File is outside the project or is not a regular file.".into()); }
    let meta = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 { return Err("File is larger than the 2 MB editor limit.".into()); }
    let bytes = fs::read(canonical).map_err(|e| format!("Cannot read file: {e}"))?;
    decode_project_text(&bytes).map_err(|e| format!("Cannot read text file (UTF-8 text files only): {e}"))
}



#[tauri::command]
fn create_project_directory(state: State<'_, ProjectState>, path: String) -> Result<(), String> {
    let root = project_root(&state)?;
    let target = safe_relative_path(&root, &path)?;
    let parent = target.parent().ok_or_else(|| "Invalid directory path.".to_string())?;
    ensure_safe_parent_directories(&root, parent)?;
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err("A file or directory already exists at that path.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect target directory: {error}")),
    }
    fs::create_dir(&target).map_err(|e| format!("Cannot create project directory: {e}"))
}

#[tauri::command]
fn write_project_file(state: State<'_, ProjectState>, path: String, content: String, expected_content: Option<String>, format: Option<ProjectTextFormat>) -> Result<(), String> {
    if content.len() > 2_000_000 {
        return Err("File is larger than the 2 MB editor limit.".into());
    }
    let root = project_root(&state)?;
    let target = safe_relative_path(&root, &path)?;
    let parent = target.parent().ok_or_else(|| "Invalid file path.".to_string())?;
    ensure_safe_parent_directories(&root, parent)?;

    verify_expected_contents(&target, expected_content.as_deref())
        .map_err(|e| format!("Cannot safely save project file: {e}"))?;
    match fs::symlink_metadata(&target) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("Refusing to write through a symbolic link.".into());
            }
            if !meta.is_file() {
                return Err("Refusing to write to a non-file.".into());
            }
            let canonical_target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
            if !canonical_target.starts_with(&root) {
                return Err("File is outside the opened project.".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect target file: {error}")),
    }
    let bytes = encode_project_text(&content, format.unwrap_or_default());
    atomic_write_file(&target, &bytes).map_err(|e| format!("Cannot save project file atomically: {e}"))
}

fn format_git_error(args: &[&str], detail: &str) -> String {
    let diagnostic = detail.trim();
    let normalized = diagnostic.to_ascii_lowercase();
    match args.first().copied() {
        Some("switch") if normalized.contains("local changes")
            || normalized.contains("would be overwritten")
            || normalized.contains("please commit your changes")
            || normalized.contains("untracked working tree files would be overwritten") =>
        {
            format!(
                "Branch switch blocked. Git left the current branch and working tree unchanged. Commit or stash the conflicting changes, then retry. Git detail: {diagnostic}"
            )
        }
        Some("pull") if normalized.contains("not possible to fast-forward")
            || normalized.contains("divergent branches")
            || normalized.contains("diverged") =>
        {
            format!(
                "Fast-forward pull blocked because the local and upstream histories have diverged. No merge or rebase was attempted. Reconcile the histories explicitly, then retry. Git detail: {diagnostic}"
            )
        }
        Some("push") if normalized.contains("non-fast-forward")
            || normalized.contains("[rejected]")
            || normalized.contains("fetch first") =>
        {
            format!(
                "Push rejected because the remote contains commits not present locally. No force push was attempted. Fetch and reconcile the histories, then retry. Git detail: {diagnostic}"
            )
        }
        _ => diagnostic.to_string(),
    }
}

fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(root).args(args).output()
        .map_err(|e| format!("Could not start Git. Install Git and ensure it is on PATH: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let detail = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(format_git_error(args, &detail));
    }
    Ok(if stderr.is_empty() { stdout } else { format!("{stdout}{stderr}") })
}


#[tauri::command]
fn git_history(state: State<'_, ProjectState>) -> Result<Vec<GitCommit>, String> {
    let root = project_root(&state)?;
    let output = run_git(&root, &[
        "log", "-n", "50",
        "--format=%H%x00%h%x00%an%x00%aI%x00%s%x1e",
    ])?;
    parse_git_history(&output)
}

#[tauri::command]
fn git_show_commit(state: State<'_, ProjectState>, hash: String) -> Result<String, String> {
    if !(hash.len() == 40 || hash.len() == 64)
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid commit identifier.".into());
    }
    let root = project_root(&state)?;
    let output = run_git(&root, &[
        "show", "--format=fuller", "--no-ext-diff", "--no-renames", "--no-color",
        "--unified=3", &hash, "--",
    ])?;
    const MAX_HISTORY_DETAIL_CHARS: usize = 24_000;
    if output.len() > MAX_HISTORY_DETAIL_CHARS {
        let mut boundary = MAX_HISTORY_DETAIL_CHARS;
        while !output.is_char_boundary(boundary) { boundary -= 1; }
        return Ok(format!("{}\n… Commit diff truncated at 24,000 characters.", &output[..boundary]));
    }
    Ok(output)
}

#[tauri::command]
fn git_status(state: State<'_, ProjectState>) -> Result<GitResult, String> {
    let root = project_root(&state)?;
    let branch = run_git(&root, &["branch", "--show-current"])?;
    let output = run_git(&root, &["status", "--short", "--branch"])?;
    Ok(GitResult { available: true, dirty: output.lines().skip(1).any(|l| !l.trim().is_empty()), output, branch: branch.trim().to_string() })
}

#[tauri::command]
fn git_diff(state: State<'_, ProjectState>) -> Result<String, String> {
    let root = project_root(&state)?;
    let tracked = run_git(&root, &["diff", "--"])?;
    let staged = run_git(&root, &["diff", "--cached", "--"])?;
    Ok(format!("--- Unstaged changes ---\n{tracked}\n--- Staged changes ---\n{staged}"))
}

#[tauri::command]
fn git_apply_hunk(state: State<'_, ProjectState>, patch: String, action: String) -> Result<String, String> {
    use std::process::Stdio;

    git_hunks::validate_hunk_patch(&patch)?;
    let args = git_hunks::apply_args(&action)?;
    let root = project_root(&state)?;
    let mut child = Command::new("git")
        .arg("-C").arg(&root).args(args)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("Could not start Git: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).map_err(|e| format!("Could not send Git hunk patch: {e}"))?;
    }
    let output = child.wait_with_output().map_err(|e| format!("Could not apply Git hunk: {e}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git rejected the hunk without applying it: {}", error.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn git_stage_all(state: State<'_, ProjectState>) -> Result<String, String> {
    let root = project_root(&state)?;
    run_git(&root, &["add", "--all"])?;
    run_git(&root, &["status", "--short"])
}

#[tauri::command]
fn git_commit(state: State<'_, ProjectState>, message: String) -> Result<String, String> {
    let root = project_root(&state)?;
    let message = message.trim();
    if message.is_empty() || message.len() > 200 { return Err("Commit message must be 1–200 characters.".into()); }
    run_git(&root, &["commit", "-m", message])
}


#[tauri::command]
fn git_list_branches(state: State<'_, ProjectState>) -> Result<Vec<String>, String> {
    let root = project_root(&state)?;
    let output = run_git(&root, &["branch", "--format=%(refname:short)"])?;
    Ok(output.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect())
}

#[tauri::command]
fn git_checkout_branch(state: State<'_, ProjectState>, branch: String) -> Result<String, String> {
    let root = project_root(&state)?;
    let branch = branch.trim();
    if branch.is_empty() || branch.len() > 200 || branch.starts_with('-') {
        return Err("Choose a valid existing local branch.".into());
    }
    run_git(&root, &["check-ref-format", "--branch", branch])?;
    let branches = run_git(&root, &["branch", "--format=%(refname:short)"])?;
    if !branches.lines().any(|line| line.trim() == branch) {
        return Err("Only existing local branches can be selected here.".into());
    }
    run_git(&root, &["switch", branch])?;
    Ok(format!("Switched to branch {branch}."))
}

#[tauri::command]
fn git_pull_ff_only(state: State<'_, ProjectState>) -> Result<String, String> {
    let root = project_root(&state)?;
    run_git(&root, &["pull", "--ff-only"])
}

#[tauri::command]
fn git_push_current_branch(state: State<'_, ProjectState>) -> Result<String, String> {
    let root = project_root(&state)?;
    run_git(&root, &["push", "-u", "origin", "HEAD"])
}

fn executable_on_path(program: &str) -> bool {
    let Some(path_value) = std::env::var_os("PATH") else { return false; };
    std::env::split_paths(&path_value).any(|directory| {
        let candidate = directory.join(program);
        if executable_file(&candidate) { return true; }
        #[cfg(windows)]
        {
            ["exe", "cmd", "bat", "com"].iter().any(|extension| {
                executable_file(&directory.join(format!("{program}.{extension}")))
            })
        }
        #[cfg(not(windows))]
        { false }
    })
}

#[cfg(windows)]
fn executable_file(path: &Path) -> bool { path.is_file() }

#[cfg(unix)]
fn executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(any(windows, unix)))]
fn executable_file(path: &Path) -> bool { path.is_file() }

#[tauri::command]
fn detect_project_tasks(state: State<'_, ProjectState>) -> Result<Vec<String>, String> {
    let root = project_root(&state)?;
    let mut tasks = Vec::new();

    if executable_on_path("npm") && root.join("package.json").is_file() {
        let scripts = fs::read_to_string(root.join("package.json")).ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            .and_then(|value| value.get("scripts").cloned())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if scripts.contains_key("build") { tasks.push("npm run build".to_string()); }
        if scripts.contains_key("test") { tasks.push("npm test".to_string()); }
    }
    if executable_on_path("cargo") && root.join("Cargo.toml").is_file() {
        tasks.push("cargo build".to_string());
        tasks.push("cargo test".to_string());
    }
    if root.join("pyproject.toml").is_file() || root.join("setup.py").is_file() {
        if executable_on_path("python") { tasks.push("python -m compileall .".to_string()); }
        else if executable_on_path("python3") { tasks.push("python3 -m compileall .".to_string()); }
    }
    if executable_on_path("make") && root.join("Makefile").is_file() { tasks.push("make".to_string()); }
    if executable_on_path("go") && root.join("go.mod").is_file() {
        tasks.push("go build ./...".to_string());
        tasks.push("go test ./...".to_string());
    }
    if executable_on_path("cmake") && root.join("CMakeLists.txt").is_file() {
        tasks.push("cmake -S . -B build".to_string());
    }
    if executable_on_path("mvn") && root.join("pom.xml").is_file() { tasks.push("mvn test".to_string()); }
    if executable_on_path("gradle") && (root.join("build.gradle").is_file() || root.join("build.gradle.kts").is_file()) {
        tasks.push("gradle test".to_string());
    }
    let has_dotnet_project = fs::read_dir(&root).map(|entries| entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        name.ends_with(".sln") || name.ends_with(".slnx") || name.ends_with(".csproj")
    })).unwrap_or(false);
    if executable_on_path("dotnet") && has_dotnet_project {
        tasks.push("dotnet build".to_string());
        tasks.push("dotnet test".to_string());
    }
    Ok(tasks)
}
fn compile_and_run_source_controlled(
    compiler: &str,
    source: &Path,
    project_root: &Path,
    command_label: String,
    cancel: Arc<AtomicBool>,
    on_output: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<TaskResult, String> {
    let temp_root = std::env::temp_dir().join(format!(
        "gocode-run-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
    ));
    fs::create_dir_all(&temp_root).map_err(|e| format!("Could not create temporary build directory: {e}"))?;
    let executable = temp_root.join(if cfg!(target_os = "windows") { "gocode-run.exe" } else { "gocode-run" });

    let mut compile = Command::new(compiler);
    compile.arg(source).arg("-o").arg(&executable).current_dir(project_root);
    let compile_result = run_bounded_command_controlled(
        &mut compile, 100_000, std::time::Duration::from_secs(300),
        Arc::clone(&cancel), Arc::clone(&on_output),
    );
    let (compile_status, compile_output, compile_timed_out, compile_cancelled) = match compile_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(format!("Could not start {compiler}. Install the compiler and ensure it is on PATH: {error}"));
        }
    };
    if compile_timed_out || compile_cancelled || !compile_status.success() {
        let _ = fs::remove_dir_all(&temp_root);
        return Ok(TaskResult {
            command: format!("{compiler} {command_label}"),
            success: false,
            output: compile_output,
            timed_out: compile_timed_out,
            cancelled: compile_cancelled,
        });
    }

    let mut execution = Command::new(&executable);
    execution.current_dir(project_root);
    let execution_result = run_bounded_command_controlled(
        &mut execution, 100_000, std::time::Duration::from_secs(30),
        cancel, on_output,
    );
    let _ = fs::remove_dir_all(&temp_root);
    let (status, output, timed_out, cancelled) = execution_result
        .map_err(|e| format!("Could not launch compiled program: {e}"))?;
    Ok(TaskResult {
        command: format!("{compiler} {command_label}"),
        success: status.success() && !timed_out && !cancelled,
        output,
        timed_out,
        cancelled,
    })
}

fn execute_source_file_controlled(
    root: &Path,
    path: &str,
    cancel: Arc<AtomicBool>,
    on_output: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<TaskResult, String> {
    let relative = safe_relative_path(root, path)?;
    let metadata = fs::symlink_metadata(&relative).map_err(|e| format!("Could not inspect source file: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Only regular, non-symlink source files can be run.".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| format!("Could not resolve project folder: {e}"))?;
    let canonical_file = relative.canonicalize().map_err(|e| format!("Could not resolve source file: {e}"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err("Source file must stay inside the opened project.".into());
    }
    let extension = canonical_file.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let source = canonical_file.to_string_lossy().into_owned();

    match extension.as_str() {
        "rs" => compile_and_run_source_controlled("rustc", &canonical_file, &canonical_root, source, cancel, on_output),
        "c" | "cpp" | "cc" | "cxx" => {
            let compiler = if extension == "c" { "cc" } else { "c++" };
            compile_and_run_source_controlled(compiler, &canonical_file, &canonical_root, source, cancel, on_output)
        }
        "py" | "js" | "mjs" | "cjs" | "go" => {
            let (program, args): (&str, Vec<String>) = match extension.as_str() {
                "py" => {
                    let interpreter = resolve_python_executable(
                        executable_on_path("python"),
                        executable_on_path("python3"),
                    ).ok_or_else(|| "Could not find Python. Install Python and ensure 'python' or 'python3' is on PATH.".to_string())?;
                    (interpreter, vec![source.clone()])
                }
                "js" | "mjs" | "cjs" => ("node", vec![source.clone()]),
                "go" => ("go", vec!["run".into(), source.clone()]),
                _ => unreachable!(),
            };
            let mut command = Command::new(program);
            command.args(&args).current_dir(&canonical_root);
            let (status, output, timed_out, cancelled) = run_bounded_command_controlled(
                &mut command, 100_000, std::time::Duration::from_secs(120), cancel, on_output,
            ).map_err(|e| format!("Could not start {program}. Install the runtime and ensure it is on PATH: {e}"))?;
            Ok(TaskResult {
                command: format!("{program} {}", args.join(" ")),
                success: status.success() && !timed_out && !cancelled,
                output, timed_out, cancelled,
            })
        }
        _ => Err("Run File supports Python, JavaScript, Go, Rust, C, and C++ files when their toolchains are installed.".into()),
    }
}

fn compile_and_run_source(
    compiler: &str,
    source: &Path,
    project_root: &Path,
    command_label: String,
) -> Result<TaskResult, String> {
    let temp_root = std::env::temp_dir().join(format!(
        "gocode-run-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
    ));
    fs::create_dir_all(&temp_root).map_err(|e| format!("Could not create temporary build directory: {e}"))?;
    let executable = temp_root.join(if cfg!(target_os = "windows") { "gocode-run.exe" } else { "gocode-run" });

    let mut compile = Command::new(compiler);
    compile.arg(source).arg("-o").arg(&executable).current_dir(project_root);
    let compile_result = run_bounded_command(&mut compile, 100_000, std::time::Duration::from_secs(300));
    let (compile_status, compile_output, compile_timed_out) = match compile_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_root);
            return Err(format!("Could not start {compiler}. Install the compiler and ensure it is on PATH: {error}"));
        }
    };
    if compile_timed_out || !compile_status.success() {
        let _ = fs::remove_dir_all(&temp_root);
        return Ok(TaskResult {
            command: format!("{compiler} {command_label}"),
            success: false,
            output: compile_output,
            timed_out: compile_timed_out,
            cancelled: false,
        });
    }

    let mut execution = Command::new(&executable);
    execution.current_dir(project_root);
    let execution_result = run_bounded_command(&mut execution, 100_000, std::time::Duration::from_secs(30));
    let _ = fs::remove_dir_all(&temp_root);
    let (status, output, timed_out) = execution_result
        .map_err(|e| format!("Could not launch compiled program: {e}"))?;
    Ok(TaskResult {
        command: format!("{compiler} {command_label}"),
        success: status.success() && !timed_out,
        output,
        timed_out,
        cancelled: false,
    })
}

#[tauri::command]
fn run_source_file(state: State<'_, ProjectState>, path: String) -> Result<TaskResult, String> {
    let root = project_root(&state)?;
    let relative = safe_relative_path(&root, &path)?;
    let metadata = fs::symlink_metadata(&relative).map_err(|e| format!("Could not inspect source file: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Only regular, non-symlink source files can be run.".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| format!("Could not resolve project folder: {e}"))?;
    let canonical_file = relative.canonicalize().map_err(|e| format!("Could not resolve source file: {e}"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err("Source file must stay inside the opened project.".into());
    }
    let extension = canonical_file.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let source = canonical_file.to_string_lossy().into_owned();

    match extension.as_str() {
        "rs" => compile_and_run_source("rustc", &canonical_file, &canonical_root, source),
        "c" | "cpp" | "cc" | "cxx" => {
            let compiler = if extension == "c" { "cc" } else { "c++" };
            compile_and_run_source(compiler, &canonical_file, &canonical_root, source)
        }
        "py" | "js" | "mjs" | "cjs" | "go" => {
            let (program, args): (&str, Vec<String>) = match extension.as_str() {
                "py" => {
                    let interpreter = resolve_python_executable(
                        executable_on_path("python"),
                        executable_on_path("python3"),
                    ).ok_or_else(|| "Could not find Python. Install Python and ensure 'python' or 'python3' is on PATH.".to_string())?;
                    (interpreter, vec![source.clone()])
                }
                "js" | "mjs" | "cjs" => ("node", vec![source.clone()]),
                "go" => ("go", vec!["run".into(), source.clone()]),
                _ => unreachable!(),
            };
            let mut command = Command::new(program);
            command.args(&args).current_dir(&canonical_root);
            let (status, output, timed_out) = run_bounded_command(
                &mut command,
                100_000,
                std::time::Duration::from_secs(120),
            ).map_err(|e| format!("Could not start {program}. Install the runtime and ensure it is on PATH: {e}"))?;
            Ok(TaskResult {
                command: format!("{program} {}", args.join(" ")),
                success: status.success() && !timed_out,
                output,
                timed_out,
                cancelled: false,
            })
        }
        _ => Err("Run File supports Python, JavaScript, Go, Rust, C, and C++ files when their toolchains are installed.".into()),
    }
}

#[derive(Default)]
struct ProjectTaskState {
    next_id: AtomicU64,
    running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}
#[derive(Clone, Serialize)]
struct TaskOutputEvent { task_id: String, data: String }
#[derive(Clone, Serialize)]
struct TaskProgressEvent { task_id: String, state: String }
#[derive(Clone, Serialize)]
struct TaskCompletedEvent { task_id: String, result: TaskResult }

#[tauri::command]
fn start_project_task(
    app: AppHandle,
    project: State<'_, ProjectState>,
    tasks: State<'_, ProjectTaskState>,
    task: String,
) -> Result<String, String> {
    let root = project_root(&project)?;
    let spec = resolve_project_task(&task)
        .ok_or_else(|| "This project task is not supported.".to_string())?;
    let id = format!("task-{}", tasks.next_id.fetch_add(1, Ordering::Relaxed));
    let cancel = Arc::new(AtomicBool::new(false));
    tasks.running.lock()
        .map_err(|_| "Task state is unavailable.".to_string())?
        .insert(id.clone(), Arc::clone(&cancel));
    let _ = app.emit("task-progress", TaskProgressEvent { task_id: id.clone(), state: "running".to_string() });

    let task_id = id.clone();
    let task_registry = Arc::clone(&tasks.running);
    thread::spawn(move || {
        let output_app = app.clone();
        let output_id = task_id.clone();
        let on_output: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |data| {
            let _ = output_app.emit("task-output", TaskOutputEvent { task_id: output_id.clone(), data });
        });
        let mut command = Command::new(spec.program);
        command.args(spec.args).current_dir(&root);
        let result = match run_bounded_command_controlled(
            &mut command, 100_000, std::time::Duration::from_secs(15 * 60), cancel, on_output,
        ) {
            Ok((status, output, timed_out, cancelled)) => TaskResult {
                command: spec.label.to_string(),
                success: status.success() && !timed_out && !cancelled,
                output, timed_out, cancelled,
            },
            Err(error) => TaskResult {
                command: spec.label.to_string(), success: false,
                output: format!("Could not run {}. Install the toolchain and ensure it is on PATH: {error}", spec.program),
                timed_out: false, cancelled: false,
            },
        };
        let state = if result.cancelled { "cancelled" }
            else if result.timed_out { "timed_out" }
            else if result.success { "completed" }
            else { "failed" };
        let _ = app.emit("task-progress", TaskProgressEvent { task_id: task_id.clone(), state: state.to_string() });
        let _ = app.emit("task-completed", TaskCompletedEvent { task_id: task_id.clone(), result });
        if let Ok(mut running) = task_registry.lock() { running.remove(&task_id); }
    });
    Ok(id)
}

#[tauri::command]
fn start_source_file_task(
    app: AppHandle,
    project: State<'_, ProjectState>,
    tasks: State<'_, ProjectTaskState>,
    path: String,
) -> Result<String, String> {
    let root = project_root(&project)?;
    // Validate the source path before acknowledging the task to the frontend.
    let relative = safe_relative_path(&root, &path)?;
    let metadata = fs::symlink_metadata(&relative).map_err(|e| format!("Could not inspect source file: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Only regular, non-symlink source files can be run.".into());
    }
    let id = format!("task-{}", tasks.next_id.fetch_add(1, Ordering::Relaxed));
    let cancel = Arc::new(AtomicBool::new(false));
    tasks.running.lock().map_err(|_| "Task state is unavailable.".to_string())?
        .insert(id.clone(), Arc::clone(&cancel));
    let _ = app.emit("task-progress", TaskProgressEvent { task_id: id.clone(), state: "running".to_string() });

    let task_id = id.clone();
    let task_registry = Arc::clone(&tasks.running);
    thread::spawn(move || {
        let output_app = app.clone();
        let output_id = task_id.clone();
        let on_output: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |data| {
            let _ = output_app.emit("task-output", TaskOutputEvent { task_id: output_id.clone(), data });
        });
        let result = execute_source_file_controlled(&root, &path, cancel, on_output)
            .unwrap_or_else(|error| TaskResult {
                command: format!("Run {path}"),
                success: false,
                output: error,
                timed_out: false,
                cancelled: false,
            });
        let state = if result.cancelled { "cancelled" }
            else if result.timed_out { "timed_out" }
            else if result.success { "completed" }
            else { "failed" };
        let _ = app.emit("task-progress", TaskProgressEvent { task_id: task_id.clone(), state: state.to_string() });
        let _ = app.emit("task-completed", TaskCompletedEvent { task_id: task_id.clone(), result });
        if let Ok(mut running) = task_registry.lock() { running.remove(&task_id); }
    });
    Ok(id)
}

#[tauri::command]
fn cancel_project_task(
    tasks: State<'_, ProjectTaskState>,
    task_id: String,
) -> Result<bool, String> {
    let running = tasks.running.lock().map_err(|_| "Task state is unavailable.".to_string())?;
    let Some(cancel) = running.get(&task_id) else { return Ok(false); };
    cancel.store(true, Ordering::Relaxed);
    Ok(true)
}

#[derive(Default)]
struct TerminalState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl Drop for TerminalState {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for (_, mut session) in sessions.drain() {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
    }
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[tauri::command]
fn start_terminal(
    app: AppHandle,
    state: State<'_, TerminalState>,
    project: State<'_, ProjectState>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let project_directory = project.root.lock()
        .map_err(|_| "Project state unavailable.".to_string())?
        .clone();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.clamp(10, 100),
            cols: cols.clamp(20, 240),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open terminal: {error}"))?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd.arg("-NoExit");
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut cmd = CommandBuilder::new("bash");
        cmd.arg("-i");
        cmd
    };

    // Start the integrated terminal in the currently opened project when one is
    // selected. Before a project is opened, keep the shell's normal default directory.
    if let Some(directory) = project_directory.as_ref() {
        command.cwd(directory);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start system shell: {error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not read terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not write terminal input: {error}"))?;

    let session_id = format!(
        "terminal-{}",
        state.next_id.fetch_add(1, Ordering::Relaxed)
    );
    state
        .sessions
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_string())?
        .insert(
            session_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );

    let output_app = app.clone();
    let output_id = session_id.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let payload = TerminalOutput {
                        session_id: output_id.clone(),
                        data: String::from_utf8_lossy(&buffer[..count]).into_owned(),
                    };
                    if output_app.emit("terminal-output", payload).is_err() {
                        break;
                    }
                }
            }
        }
    });

    Ok(session_id)
}

#[tauri::command]
fn write_terminal_input(
    state: State<'_, TerminalState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Terminal session was not found.".to_string())?;
    session
        .writer
        .write_all(input.as_bytes())
        .map_err(|error| format!("Could not write to terminal: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("Could not flush terminal input: {error}"))
}

#[tauri::command]
fn resize_terminal(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session was not found.".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.clamp(10, 100),
            cols: cols.clamp(20, 240),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not resize terminal: {error}"))
}

#[tauri::command]
fn close_terminal(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Terminal state is unavailable.".to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionPackageInspection {
    manifest: ExtensionPackageManifest,
    entry_count: usize,
    total_uncompressed_bytes: u64,
    sha256: String,
}

/// Opens a native file picker and validates a ZIP package without installing or
/// executing it. Keeping path selection inside the native command avoids exposing
/// an arbitrary-path file reader to the webview.
#[tauri::command]
async fn inspect_extension_package(app: AppHandle) -> Result<Option<ExtensionPackageInspection>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Extension package", &["zip"])
        .pick_file(move |selection| {
            let _ = sender.send(selection);
        });

    let selection = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|_| "Extension package picker closed unexpectedly.".to_string())
    })
    .await
    .map_err(|error| format!("Extension package picker failed: {error}"))??;
    let Some(selection) = selection else { return Ok(None); };
    let path = selection.into_path()
        .map_err(|error| format!("Selected extension package is not a local file: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        let staged = stage_extension_archive(&path)?;
        Ok(Some(ExtensionPackageInspection {
            manifest: staged.manifest,
            entry_count: staged.entry_count,
            total_uncompressed_bytes: staged.total_uncompressed_bytes,
            sha256: staged.sha256,
        }))
    })
    .await
    .map_err(|error| format!("Extension package validation worker failed: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalState::default())
        .manage(lsp::LspState::default())
        .manage(dap::DapState::default())
        .manage(ProjectState::default())
        .manage(ProjectSearchState::default())
        .manage(ProjectTaskState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            dap::dap_start,
            dap::dap_send,
            dap::dap_stop,
            start_terminal,
            write_terminal_input,
            resize_terminal,
            close_terminal,
            inspect_extension_package,
            set_project_root,
            get_project_root,
            list_project_files,
            search_project_files,
            cancel_project_search,
            read_project_file,
            write_project_file,
            create_project_directory,
            git_status,
            git_history,
            git_show_commit,
            git_diff,
            git_apply_hunk,
            git_stage_all,
            git_commit,
            git_list_branches,
            git_checkout_branch,
            git_pull_ff_only,
            git_push_current_branch,
            detect_project_tasks,
            start_project_task,
            start_source_file_task,
            cancel_project_task,
            run_source_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gocode IDE");
}

#[cfg(test)]
mod project_path_tests {
    use super::{ensure_safe_parent_directories, normalize_search_query, safe_relative_path};
    use std::path::Path;

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


#[cfg(test)]
mod git_history_tests {
    use super::{format_git_error, parse_git_history};

    #[test]
    fn explains_branch_switch_blocked_by_local_changes_without_losing_git_detail() {
        let error = format_git_error(
            &["switch", "feature"],
            "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/main.rs",
        );
        assert!(error.contains("Branch switch blocked"));
        assert!(error.contains("working tree unchanged"));
        assert!(error.contains("src/main.rs"));
    }

    #[test]
    fn explains_fast_forward_pull_divergence_without_attempting_merge() {
        let error = format_git_error(
            &["pull", "--ff-only"],
            "fatal: Not possible to fast-forward, aborting.",
        );
        assert!(error.contains("Fast-forward pull blocked"));
        assert!(error.contains("No merge or rebase was attempted"));
    }

    #[test]
    fn explains_non_fast_forward_push_and_never_suggests_force_push() {
        let error = format_git_error(
            &["push", "-u", "origin", "HEAD"],
            "! [rejected] HEAD -> feature (non-fast-forward)",
        );
        assert!(error.contains("Push rejected"));
        assert!(error.contains("No force push was attempted"));
    }

    fn test_git(root: &std::path::Path, args: &[&str]) -> String {
        use std::process::Command;
        let output = Command::new("git").arg("-C").arg(root).args(args).output()
            .expect("Git must be installed for native Git integration tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn test_directory(label: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        std::env::temp_dir().join(format!(
            "gocode-{label}-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    fn configure_test_identity(root: &std::path::Path) {
        test_git(root, &["config", "user.name", "Gocode IDE Test"]);
        test_git(root, &["config", "user.email", "gocode-test@example.invalid"]);
        test_git(root, &["config", "--local", "credential.helper", ""]);
    }

    #[test]
    fn blocked_branch_switch_preserves_dirty_worktree_and_current_branch() {
        use std::fs;

        let root = test_directory("git-switch-safety");
        fs::create_dir_all(&root).unwrap();
        test_git(&root, &["init", "-b", "main"]);
        configure_test_identity(&root);
        fs::write(root.join("shared.txt"), "base\n").unwrap();
        test_git(&root, &["add", "shared.txt"]);
        test_git(&root, &["commit", "-m", "base"]);
        test_git(&root, &["switch", "-c", "feature"]);
        fs::write(root.join("shared.txt"), "feature version\n").unwrap();
        test_git(&root, &["commit", "-am", "feature edit"]);
        test_git(&root, &["switch", "main"]);

        fs::write(root.join("shared.txt"), "uncommitted local work\n").unwrap();
        let error = super::run_git(&root, &["switch", "feature"]).unwrap_err();
        assert!(error.contains("Branch switch blocked"), "{error}");
        assert_eq!(test_git(&root, &["branch", "--show-current"]), "main");
        assert_eq!(fs::read_to_string(root.join("shared.txt")).unwrap(), "uncommitted local work\n");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_remote_pull_and_push_work_without_interactive_credentials() {
        use std::fs;
        use std::process::Command;

        let bare = test_directory("git-remote-bare");
        let local = test_directory("git-remote-local");
        let peer = test_directory("git-remote-peer");
        let init = Command::new("git").args(["init", "--bare", "-b", "main"])
            .arg(&bare).output().expect("Git must be installed");
        assert!(init.status.success(), "bare repository init failed");

        fs::create_dir_all(&local).unwrap();
        test_git(&local, &["init", "-b", "main"]);
        configure_test_identity(&local);
        fs::write(local.join("base.txt"), "base\n").unwrap();
        test_git(&local, &["add", "base.txt"]);
        test_git(&local, &["commit", "-m", "initial"]);
        test_git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
        test_git(&local, &["push", "-u", "origin", "main"]);

        let peer_clone = Command::new("git").arg("clone").arg(&bare).arg(&peer)
            .output().expect("Git must be installed");
        assert!(peer_clone.status.success(), "peer clone failed: {}", String::from_utf8_lossy(&peer_clone.stderr));
        configure_test_identity(&peer);
        fs::write(peer.join("remote.txt"), "from remote\n").unwrap();
        test_git(&peer, &["add", "remote.txt"]);
        test_git(&peer, &["commit", "-m", "remote advance"]);
        test_git(&peer, &["push", "origin", "main"]);

        super::run_git(&local, &["pull", "--ff-only"]).expect("fast-forward pull should succeed");
        let pulled_contents = fs::read_to_string(local.join("remote.txt")).unwrap();
        assert_eq!(pulled_contents.replace("\r\n", "\n"), "from remote\n");

        fs::write(local.join("local.txt"), "from local\n").unwrap();
        test_git(&local, &["add", "local.txt"]);
        test_git(&local, &["commit", "-m", "local advance"]);
        super::run_git(&local, &["push", "-u", "origin", "HEAD"]).expect("push to local remote should succeed");
        let remote_head = Command::new("git").arg("--git-dir").arg(&bare)
            .args(["rev-parse", "refs/heads/main"]).output().expect("Git must be installed");
        assert!(remote_head.status.success());
        assert_eq!(String::from_utf8_lossy(&remote_head.stdout).trim(), test_git(&local, &["rev-parse", "HEAD"]));

        fs::remove_dir_all(bare).unwrap();
        fs::remove_dir_all(local).unwrap();
        fs::remove_dir_all(peer).unwrap();
    }

            }

