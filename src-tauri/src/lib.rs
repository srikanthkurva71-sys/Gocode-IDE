mod lsp_protocol;

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, Child};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

fn safe_relative_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
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

fn project_root(state: &State<'_, ProjectState>) -> Result<PathBuf, String> {
    state.root.lock().map_err(|_| "Project state unavailable.".to_string())?
        .clone().ok_or_else(|| "Open a project folder first.".to_string())
}

#[tauri::command]
fn set_project_root(state: State<'_, ProjectState>, path: String) -> Result<String, String> {
    let canonical = fs::canonicalize(&path).map_err(|e| format!("Cannot open project folder: {e}"))?;
    if !canonical.is_dir() { return Err("Selected project path is not a directory.".into()); }
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

fn search_project_root(root: &Path, query: &str) -> Result<Vec<ProjectSearchResult>, String> {
    let mut stack = vec![(root.to_path_buf(), String::new())];
    let mut results = Vec::new();
    let mut inspected_files = 0usize;
    let mut inspected_entries = 0usize;
    while let Some((directory, prefix)) = stack.pop() {
        let read = fs::read_dir(&directory)
            .map_err(|e| format!("Cannot read project directory: {e}"))?;
        for item in read.flatten() {
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
                    if results.len() >= 200 { return Ok(results); }
                }
            }
        }
        if inspected_files > 10000 || inspected_entries > 10000 { break; }
    }
    results.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()).then(a.line_number.cmp(&b.line_number)));
    Ok(results)
}

#[tauri::command]
fn search_project_files(
    state: State<'_, ProjectState>,
    query: String,
) -> Result<Vec<ProjectSearchResult>, String> {
    let root = project_root(&state)?;
    let query = normalize_search_query(&query)?;
    search_project_root(&root, &query)
}

#[tauri::command]
fn read_project_file(state: State<'_, ProjectState>, path: String) -> Result<String, String> {
    let root = project_root(&state)?;
    let target = safe_relative_path(&root, &path)?;
    let canonical = fs::canonicalize(&target).map_err(|e| format!("Cannot read file: {e}"))?;
    if !canonical.starts_with(&root) || !canonical.is_file() { return Err("File is outside the project or is not a regular file.".into()); }
    let meta = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if meta.len() > 2_000_000 { return Err("File is larger than the 2 MB editor limit.".into()); }
    fs::read_to_string(canonical).map_err(|e| format!("Cannot read text file (binary files are not supported): {e}"))
}

#[tauri::command]
fn ensure_safe_parent_directories(root: &Path, parent: &Path) -> Result<(), String> {
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
fn write_project_file(state: State<'_, ProjectState>, path: String, content: String) -> Result<(), String> {
    if content.len() > 2_000_000 {
        return Err("File is larger than the 2 MB editor limit.".into());
    }
    let root = project_root(&state)?;
    let target = safe_relative_path(&root, &path)?;
    let parent = target.parent().ok_or_else(|| "Invalid file path.".to_string())?;
    ensure_safe_parent_directories(&root, parent)?;

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
    fs::write(target, content).map_err(|e| format!("Cannot save project file: {e}"))
}

fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git").arg("-C").arg(root).args(args).output()
        .map_err(|e| format!("Could not start Git. Install Git and ensure it is on PATH: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() { return Err(if stderr.trim().is_empty() { stdout } else { stderr }); }
    Ok(if stderr.is_empty() { stdout } else { format!("{stdout}{stderr}") })
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

#[derive(Serialize)]
struct TaskResult { command: String, success: bool, output: String }

#[tauri::command]
fn detect_project_tasks(state: State<'_, ProjectState>) -> Result<Vec<String>, String> {
    let root = project_root(&state)?;
    let mut tasks = Vec::new();
    if root.join("package.json").is_file() {
        tasks.push("npm run build".to_string());
        tasks.push("npm test".to_string());
    }
    if root.join("Cargo.toml").is_file() { tasks.push("cargo build".to_string()); tasks.push("cargo test".to_string()); }
    if root.join("pyproject.toml").is_file() || root.join("setup.py").is_file() { tasks.push("python -m compileall .".to_string()); }
    if root.join("Makefile").is_file() { tasks.push("make".to_string()); }
    if root.join("go.mod").is_file() { tasks.push("go build ./...".to_string()); tasks.push("go test ./...".to_string()); }
    if root.join("CMakeLists.txt").is_file() { tasks.push("cmake -S . -B build".to_string()); }
    Ok(tasks)
}

#[tauri::command]
fn run_source_file(state: State<'_, ProjectState>, path: String) -> Result<TaskResult, String> {
    let root = project_root(&state)?;
    let relative = safe_relative_path(&root, &path)?;
    let metadata = fs::symlink_metadata(&relative).map_err(|e| format!("Could not inspect source file: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() { return Err("Only regular, non-symlink source files can be run.".into()); }
    let canonical_root = root.canonicalize().map_err(|e| format!("Could not resolve project folder: {e}"))?;
    let canonical_file = relative.canonicalize().map_err(|e| format!("Could not resolve source file: {e}"))?;
    if !canonical_file.starts_with(&canonical_root) { return Err("Source file must stay inside the opened project.".into()); }
    let extension = canonical_file.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let source = canonical_file.to_string_lossy().into_owned();
    let (program, args): (&str, Vec<String>) = match extension.as_str() {
        "py" => ("python", vec![source.clone()]),
        "js" | "mjs" | "cjs" => ("node", vec![source.clone()]),
        "go" => ("go", vec!["run".into(), source.clone()]),
        "rs" => {
            let temp_root = std::env::temp_dir().join(format!("gocode-run-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
            fs::create_dir_all(&temp_root).map_err(|e| format!("Could not create temporary build directory: {e}"))?;
            let executable = temp_root.join(if cfg!(target_os = "windows") { "gocode-run.exe" } else { "gocode-run" });
            let compile = Command::new("rustc").arg(&canonical_file).arg("-o").arg(&executable).current_dir(&canonical_root).output()
                .map_err(|e| { let _ = fs::remove_dir_all(&temp_root); format!("Could not start rustc. Install Rust and ensure it is on PATH: {e}") })?;
            let mut compile_text = String::from_utf8_lossy(&compile.stdout).to_string();
            compile_text.push_str(&String::from_utf8_lossy(&compile.stderr));
            if !compile.status.success() {
                let _ = fs::remove_dir_all(&temp_root);
                if compile_text.len() > 100_000 { compile_text.truncate(100_000); compile_text.push_str("\n[Output truncated]"); }
                return Ok(TaskResult { command: format!("rustc {} -o <temporary executable>", source), success: false, output: compile_text });
            }
            let execution = Command::new(&executable).current_dir(&canonical_root).output()
                .map_err(|e| { let _ = fs::remove_dir_all(&temp_root); format!("Could not launch compiled Rust program: {e}") });
            let _ = fs::remove_dir_all(&temp_root);
            let execution = execution?;
            let mut text = String::from_utf8_lossy(&execution.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&execution.stderr));
            if text.len() > 100_000 { text.truncate(100_000); text.push_str("\n[Output truncated]"); }
            return Ok(TaskResult { command: format!("rustc {} → temporary executable", source), success: execution.status.success(), output: text });
        }
        "c" | "cpp" | "cc" | "cxx" => {
            let compiler = if extension == "c" { "cc" } else { "c++" };
            let temp_root = std::env::temp_dir().join(format!("gocode-run-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
            fs::create_dir_all(&temp_root).map_err(|e| format!("Could not create temporary build directory: {e}"))?;
            let executable = temp_root.join(if cfg!(target_os = "windows") { "gocode-run.exe" } else { "gocode-run" });
            let compile = Command::new(compiler).arg(&canonical_file).arg("-o").arg(&executable).current_dir(&canonical_root).output()
                .map_err(|e| { let _ = fs::remove_dir_all(&temp_root); format!("Could not start {compiler}. Install a C/C++ compiler and ensure it is on PATH: {e}") })?;
            let mut compile_text = String::from_utf8_lossy(&compile.stdout).to_string();
            compile_text.push_str(&String::from_utf8_lossy(&compile.stderr));
            if !compile.status.success() {
                let _ = fs::remove_dir_all(&temp_root);
                if compile_text.len() > 100_000 { compile_text.truncate(100_000); compile_text.push_str("\n[Output truncated]"); }
                return Ok(TaskResult { command: format!("{compiler} {} -o <temporary executable>", source), success: false, output: compile_text });
            }
            let execution = Command::new(&executable).current_dir(&canonical_root).output()
                .map_err(|e| { let _ = fs::remove_dir_all(&temp_root); format!("Could not launch compiled program: {e}") });
            let _ = fs::remove_dir_all(&temp_root);
            let execution = execution?;
            let mut text = String::from_utf8_lossy(&execution.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&execution.stderr));
            if text.len() > 100_000 { text.truncate(100_000); text.push_str("\n[Output truncated]"); }
            return Ok(TaskResult { command: format!("{compiler} {} → temporary executable", source), success: execution.status.success(), output: text });
        }
        _ => return Err("Run File supports Python, JavaScript, Go, Rust, C, and C++ files when their toolchains are installed.".into()),
    };
    let output = Command::new(program).args(&args).current_dir(&canonical_root).output()
        .map_err(|e| format!("Could not start {program}. Install the runtime and ensure it is on PATH: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if text.len() > 100_000 { text.truncate(100_000); text.push_str("\n[Output truncated]"); }
    Ok(TaskResult { command: format!("{program} {}", args.join(" ")), success: output.status.success(), output: text })
}

#[tauri::command]
fn run_project_task(state: State<'_, ProjectState>, task: String) -> Result<TaskResult, String> {
    let root = project_root(&state)?;
    let allowed: &[(&str, &str, &[&str])] = &[
        ("npm run build", "npm", &["run", "build"]),
        ("npm test", "npm", &["test"]),
        ("cargo build", "cargo", &["build"]),
        ("cargo test", "cargo", &["test"]),
        ("python -m compileall .", "python", &["-m", "compileall", "."]),
        ("make", "make", &[]),
        ("go build ./...", "go", &["build", "./..."]),
        ("go test ./...", "go", &["test", "./..."]),
        ("cmake -S . -B build", "cmake", &["-S", ".", "-B", "build"]),
    ];
    let (program, args) = allowed.iter().find(|(label, _, _)| *label == task)
        .map(|(_, program, args)| (*program, *args)).ok_or_else(|| "This project task is not supported.".to_string())?;
    let output = Command::new(program).args(args).current_dir(&root).output()
        .map_err(|e| format!("Could not start {program}. Install the toolchain and ensure it is on PATH: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if text.len() > 100_000 { text.truncate(100_000); text.push_str("\n[Output truncated]"); }
    Ok(TaskResult { command: task, success: output.status.success(), output: text })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalState::default())
        .manage(lsp::LspState::default())
        .manage(dap::DapState::default())
        .manage(ProjectState::default())
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
            set_project_root,
            get_project_root,
            list_project_files,
            search_project_files,
            read_project_file,
            write_project_file,
            create_project_directory,
            git_status,
            git_diff,
            git_stage_all,
            git_commit,
            git_list_branches,
            git_checkout_branch,
            git_pull_ff_only,
            git_push_current_branch,
            detect_project_tasks,
            run_project_task,
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
        use std::{fs, time::{SystemTime, UNIX_EPOCH}};

        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-search-test-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}\nlet TARGET = 1;\n").unwrap();
        let results = search_project_root(&root, "target").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "src/main.rs");
        assert_eq!(results[0].line_number, 2);
        assert!(results[0].snippet.contains("TARGET"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_skips_generated_directories() {
        use super::search_project_root;
        use std::{fs, time::{SystemTime, UNIX_EPOCH}};

        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gocode-search-test-{unique}"));
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("hidden.txt"), "secretneedle").unwrap();
        let results = search_project_root(&root, "secretneedle").unwrap();
        assert!(results.is_empty());
        fs::remove_dir_all(root).unwrap();
    }


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
            "src\\\\main.rs",
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
