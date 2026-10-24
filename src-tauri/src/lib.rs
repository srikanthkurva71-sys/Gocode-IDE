use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, PtySystem, Child};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
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
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err("Path must stay inside the opened project.".into());
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
            let meta = match item.metadata() { Ok(m) => m, Err(_) => continue };
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
fn write_project_file(state: State<'_, ProjectState>, path: String, content: String) -> Result<(), String> {
    let root = project_root(&state)?;
    let target = safe_relative_path(&root, &path)?;
    let parent = target.parent().ok_or_else(|| "Invalid file path.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create parent directory: {e}"))?;
    let canonical_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !canonical_parent.starts_with(&root) { return Err("File is outside the opened project.".into()); }
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
    cols: u16,
    rows: u16,
) -> Result<String, String> {
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
        .manage(ProjectState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            start_terminal,
            write_terminal_input,
            resize_terminal,
            close_terminal,
            set_project_root,
            get_project_root,
            list_project_files,
            read_project_file,
            write_project_file,
            git_status,
            git_diff,
            git_stage_all,
            git_commit,
            detect_project_tasks,
            run_project_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gocode IDE");
}
