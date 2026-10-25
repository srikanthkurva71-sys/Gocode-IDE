import { useEffect, useMemo, useState, type FormEvent, type ChangeEvent } from "react";
import Editor from "@monaco-editor/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { findWorkspaceMatches, formatTaskOutput, isValidRelativeFileName, isWithinTextImportLimit, MAX_WORKSPACE_BACKUP_BYTES, MAX_WORKSPACE_FILES, MAX_WORKSPACE_FILE_CHARS, sanitizeWorkspaceFiles } from "./lib/workspace";

type Panel = "Explorer" | "Search" | "Source Control" | "Run & Debug" | "Extensions" | "Settings";
type Workspace = Record<string, string>;
type ProjectEntry = { path: string; is_dir: boolean; size: number };
type ProjectSearchResult = { path: string; line_number: number; snippet: string };
type GitResult = { available: boolean; output: string; branch: string; dirty: boolean };
type TaskResult = { command: string; success: boolean; output: string };
type ExtensionManifest = { id: string; name: string; version: string; publisher: string; license: string; description: string; capabilities: string[] };
type EditorDiagnostic = { message: string; lineNumber: number; column: number; severity: number };
const STORAGE_KEY = "gocode-ide-workspace-v1";
const PROJECT_ROOT_KEY = "gocode-ide-last-project-root-v1";
const EXTENSIONS_KEY = "gocode-ide-extension-manifests-v1";
const EDITOR_SETTINGS_KEY = "gocode-ide-editor-settings-v1";
const welcome = "# Welcome to Gocode IDE\n\nA free, local-first development environment.\n\nThe desktop prototype includes a native project explorer, local Git actions, a terminal, and fixed build-task adapters. Language-server intelligence, DAP debugging, and executable extension hosting are still in development. Browser preview files remain in browser storage; export a workspace backup to keep a copy.";
function languageForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", html: "html", css: "css", scss: "scss", md: "markdown", py: "python", rs: "rust", c: "c", h: "c", cpp: "cpp", hpp: "cpp", java: "java", cs: "csharp", go: "go", rb: "ruby", php: "php", xml: "xml", yaml: "yaml", yml: "yaml", sh: "shell", sql: "sql", toml: "ini", ps1: "powershell", bat: "bat" };
  return (ext && languages[ext]) || "plaintext";
}

const panels: { name: Panel; icon: string }[] = [
  { name: "Explorer", icon: "▤" }, { name: "Search", icon: "⌕" },
  { name: "Source Control", icon: "⑂" }, { name: "Run & Debug", icon: "▷" },
  { name: "Extensions", icon: "▦" }, { name: "Settings", icon: "⚙" }
];

function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const result = sanitizeWorkspaceFiles(value);
        if (Object.keys(result).length) return result;
      }
    }
  } catch { /* Use the starter workspace if saved browser data is invalid. */ }
  return { "Welcome.md": welcome };
}

export default function App() {
  const [panel, setPanel] = useState<Panel>("Explorer");
  const [files, setFiles] = useState<Workspace>(loadWorkspace);
  const [nativePaths, setNativePaths] = useState<Record<string, string>>({});
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [gitInfo, setGitInfo] = useState<GitResult | null>(null);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [gitDiff, setGitDiff] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [tasks, setTasks] = useState<string[]>([]);
  const [taskOutput, setTaskOutput] = useState("");
  const [taskRunning, setTaskRunning] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionManifest[]>(() => { try { const v = JSON.parse(localStorage.getItem(EXTENSIONS_KEY) || "[]"); return Array.isArray(v) ? v.filter(x => x && typeof x.id === "string" && typeof x.name === "string") : []; } catch { return []; } });
  const [extensionError, setExtensionError] = useState("");
  const [wordWrap, setWordWrap] = useState<boolean>(() => { try { return JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || "{}").wordWrap === true; } catch { return false; } });
  const [minimap, setMinimap] = useState<boolean>(() => { try { return JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || "{}").minimap === true; } catch { return false; } });
  const [fileName, setFileName] = useState("Welcome.md");
  const [draftName, setDraftName] = useState("");
  const [newFile, setNewFile] = useState(false);
  const [showTerminal, setShowTerminal] = useState(true);
  const terminalHost = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState("Ready");
  const [editorDiagnostics, setEditorDiagnostics] = useState<EditorDiagnostic[]>([]);
  const [bottomPanel, setBottomPanel] = useState<"problems" | "terminal">("terminal");
  const [searchTerm, setSearchTerm] = useState("");
  const [projectSearchResults, setProjectSearchResults] = useState<ProjectSearchResult[]>([]);
  const [projectSearchBusy, setProjectSearchBusy] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showFind, setShowFind] = useState(false);
  const text = files[fileName] ?? "";
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const matches = useMemo(() => findWorkspaceMatches(files, searchTerm), [files, searchTerm]);

  useEffect(() => {
    try { localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(extensions)); }
    catch { setExtensionError("Could not save extension manifest list in browser storage."); }
  }, [extensions]);

  useEffect(() => {
    try { localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify({ wordWrap, minimap })); }
    catch { /* Settings remain active for this session. */ }
  }, [wordWrap, minimap]);

  function importExtensionManifest(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 64 * 1024) { setExtensionError("Manifest exceeds the 64 KB limit."); return; }
    void file.text().then(raw => {
      try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Manifest must be a JSON object.");
        const m = value as Record<string, unknown>;
        for (const key of ["id", "name", "version", "publisher", "license", "description"]) {
          if (typeof m[key] !== "string" || !(m[key] as string).trim()) throw new Error("Missing required text field: " + key);
        }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(m.id as string)) throw new Error("Extension id must be 2–80 characters using letters, numbers, dot, underscore, or hyphen.");
        if (!Array.isArray(m.capabilities) || m.capabilities.some(x => typeof x !== "string" || x.length > 80)) throw new Error("capabilities must be an array of short strings.");
        const manifest: ExtensionManifest = { id: m.id as string, name: m.name as string, version: m.version as string, publisher: m.publisher as string, license: m.license as string, description: m.description as string, capabilities: m.capabilities as string[] };
        setExtensions(old => old.some(x => x.id === manifest.id) ? old.map(x => x.id === manifest.id ? manifest : x) : [...old, manifest]);
        setExtensionError("Manifest added for review. Its code has NOT been installed or executed.");
      } catch (error) { setExtensionError("Invalid manifest: " + String(error)); }
    });
  }

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(files)); }
    catch { setMessage("Browser storage is full. Download your files for backup."); }
  }, [files]);

  useEffect(() => {
    if (!showTerminal || !isTauri() || !terminalHost.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 12,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      theme: { background: "#111318", foreground: "#d6dbea", cursor: "#8da7ff" },
      scrollback: 3000
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHost.current);
    fitAddon.fit();

    let sessionId: string | null = null;
    let unlisten: (() => void) | undefined;
    let inputSubscription: { dispose: () => void } | undefined;
    let disposed = false;
    const setup = async () => {
      try {
        unlisten = await listen<{ session_id: string; data: string }>("terminal-output", event => {
          if (event.payload.session_id === sessionId) terminal.write(event.payload.data);
        });
        sessionId = await invoke<string>("start_terminal", { cols: terminal.cols, rows: terminal.rows });
        if (disposed) {
          void invoke("close_terminal", { sessionId });
          return;
        }
        terminal.write("Gocode IDE native terminal ready.\r\n");
        inputSubscription = terminal.onData(data => {
          if (sessionId) void invoke("write_terminal_input", { sessionId, input: data }).catch(error => setMessage("Terminal input failed: " + String(error)));
        });
      } catch (error) {
        terminal.write("\r\nTerminal could not start: " + String(error) + "\r\n");
        setMessage("Terminal could not start.");
      }
    };
    void setup();

    const resize = () => {
      fitAddon.fit();
      if (sessionId) void invoke("resize_terminal", { sessionId, cols: terminal.cols, rows: terminal.rows });
    };
    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      inputSubscription?.dispose();
      unlisten?.();
      if (sessionId) void invoke("close_terminal", { sessionId });
      terminal.dispose();
    };
  }, [showTerminal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); void saveCurrentFile();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault(); setPanel("Explorer"); setNewFile(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); setPanel("Search"); setShowFind(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function download(name: string, body: string, type = "text/plain;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadFile() {
    download(fileName, text);
    setMessage("Downloaded " + fileName);
  }
  async function refreshProject() {
    try {
      const entries = await invoke<ProjectEntry[]>("list_project_files");
      setProjectEntries(entries);
      const available = await invoke<string[]>("detect_project_tasks");
      setTasks(available);
      try { setGitInfo(await invoke<GitResult>("git_status")); }
      catch { setGitInfo(null); }
    } catch (error) { setMessage("Project refresh failed: " + String(error)); }
  }
  async function openProjectFolder() {
    try {
      const selected = await openDialog({ multiple: false, directory: true, title: "Open project folder" });
      if (!selected || Array.isArray(selected)) return;
      const root = await invoke<string>("set_project_root", { path: selected });
      setProjectRoot(root);
      try { localStorage.setItem(PROJECT_ROOT_KEY, root); } catch { /* Project can still be used for this session. */ }
      await refreshProject();
      setPanel("Explorer");
      setMessage("Opened project: " + root);
    } catch (error) { setMessage("Open project failed: " + String(error)); }
  }
  async function openProjectEntry(path: string) {
    try {
      const contents = await invoke<string>("read_project_file", { path });
      setFiles(current => ({ ...current, [path]: contents }));
      setFileName(path);
      setPanel("Explorer");
      setMessage("Opened project file " + path);
    } catch (error) { setMessage("Open project file failed: " + String(error)); }
  }
  async function saveProjectFile() {
    try {
      await invoke("write_project_file", { path: fileName, content: text });
      setMessage("Saved project file " + fileName);
      await refreshProject();
    } catch (error) { setMessage("Project save failed: " + String(error)); }
  }
  async function searchProject() {
    if (!projectRoot) {
      setMessage("Open a project folder before searching project files.");
      return;
    }
    if (!searchTerm.trim()) {
      setProjectSearchResults([]);
      setMessage("Enter text to search for.");
      return;
    }
    setProjectSearchBusy(true);
    try {
      const results = await invoke<ProjectSearchResult[]>("search_project_files", { query: searchTerm });
      setProjectSearchResults(results);
      setMessage(`Project search found ${results.length} matching line(s).`);
    } catch (error) {
      setMessage("Project search failed: " + String(error));
    } finally {
      setProjectSearchBusy(false);
    }
  }

  async function refreshGit() {
    try {
      setGitInfo(await invoke<GitResult>("git_status"));
      setGitDiff(await invoke<string>("git_diff"));
      const branches = await invoke<string[]>("git_list_branches");
      setGitBranches(branches);
      setSelectedBranch(current => branches.includes(current) ? current : (branches[0] ?? ""));
      setMessage("Git status refreshed.");
    } catch (error) { setGitInfo(null); setMessage("Git unavailable: " + String(error)); }
  }
  async function stageGitChanges() {
    try {
      const output = await invoke<string>("git_stage_all");
      setMessage("Git stage complete. " + output.trim());
      await refreshGit();
    } catch (error) { setMessage("Git stage failed: " + String(error)); }
  }
  async function commitGitChanges() {
    try {
      const output = await invoke<string>("git_commit", { message: commitMessage });
      setMessage("Git commit created.");
      setTaskOutput(output);
      setCommitMessage("");
      await refreshGit();
    } catch (error) { setMessage("Git commit failed: " + String(error)); }
  }
  async function checkoutGitBranch() {
    if (!selectedBranch) return;
    setGitBusy(true);
    try {
      setMessage(await invoke<string>("git_checkout_branch", { branch: selectedBranch }));
      await refreshGit();
      await refreshProject();
    } catch (error) { setMessage("Branch switch failed: " + String(error)); }
    finally { setGitBusy(false); }
  }
  async function syncGit(action: "pull" | "push") {
    const confirmed = window.confirm(action === "pull"
      ? "Pull from the configured upstream using fast-forward only? Local changes may prevent this."
      : "Push the current branch to the remote named origin?");
    if (!confirmed) return;
    setGitBusy(true);
    try {
      const output = await invoke<string>(action === "pull" ? "git_pull_ff_only" : "git_push_current_branch");
      setTaskOutput(output);
      setMessage("Git " + action + " completed.");
      await refreshGit();
      await refreshProject();
    } catch (error) { setMessage("Git " + action + " failed: " + String(error)); }
    finally { setGitBusy(false); }
  }
  async function runTask(task: string) {
    const confirmed = window.confirm(
      "Run this project command?\n\n" + task + "\n\nBuild and test commands execute code from the opened project. Only continue if you trust this project."
    );
    if (!confirmed) {
      setMessage("Project task cancelled.");
      return;
    }
    setTaskRunning(true);
    setTaskOutput("Running " + task + " …");
    try {
      const result = await invoke<TaskResult>("run_project_task", { task });
      setTaskOutput(formatTaskOutput(result.success, result.command, result.output));
      setMessage(result.success ? task + " completed." : task + " failed.");
    } catch (error) {
      setTaskOutput("Could not run task: " + String(error));
      setMessage("Build/run task failed to start.");
    } finally { setTaskRunning(false); }
  }
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<string | null>("get_project_root").then(async activeRoot => {
      if (activeRoot) {
        setProjectRoot(activeRoot);
        try { localStorage.setItem(PROJECT_ROOT_KEY, activeRoot); } catch { /* Optional convenience only. */ }
        await refreshProject();
        return;
      }
      // Remember only the last folder path locally; project files are not copied or uploaded.
      let rememberedRoot = "";
      try { rememberedRoot = localStorage.getItem(PROJECT_ROOT_KEY) || ""; } catch { /* Storage may be unavailable. */ }
      if (!rememberedRoot) return;
      try {
        const restoredRoot = await invoke<string>("set_project_root", { path: rememberedRoot });
        setProjectRoot(restoredRoot);
        await refreshProject();
        setMessage("Restored project: " + restoredRoot);
      } catch {
        setMessage("Your last project folder is unavailable. Choose a project folder to continue.");
      }
    }).catch(() => undefined);
  }, []);

  async function openNativeFile() {
    try {
      const selected = await openDialog({ multiple: false, directory: false, filters: [{ name: "Source files", extensions: ["txt", "md", "ts", "tsx", "js", "jsx", "json", "html", "css", "py", "rs", "c", "cpp", "h", "java", "go", "yaml", "yml", "toml", "xml", "sql", "sh"] }] });
      if (!selected || Array.isArray(selected)) return;
      const contents = await readTextFile(selected);
      const name = selected.split(/[\\\\/]/).pop() || "Untitled.txt";
      setFiles(current => ({ ...current, [name]: contents }));
      setNativePaths(current => ({ ...current, [name]: selected }));
      setFileName(name); setPanel("Explorer"); setMessage("Opened " + name);
    } catch (error) { setMessage("Open failed: " + String(error)); }
  }
  async function saveCurrentFile() {
    if (isTauri() && projectRoot && projectEntries.some(entry => entry.path === fileName && !entry.is_dir) && !nativePaths[fileName]) { await saveProjectFile(); return; }
    if (!isTauri()) { downloadFile(); return; }
    try {
      const path = nativePaths[fileName] ?? await saveDialog({ defaultPath: fileName, filters: [{ name: "Text and source files", extensions: [fileName.split(".").pop() || "txt"] }] });
      if (!path || typeof path !== "string") return;
      await writeTextFile(path, text);
      setNativePaths(current => ({ ...current, [fileName]: path }));
      setMessage("Saved " + fileName);
    } catch (error) { setMessage("Save failed: " + String(error)); }
  }
  async function createFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draftName.trim();
    if (!isValidRelativeFileName(name)) {
      setMessage("Enter a valid relative file name."); return;
    }
    if (Object.prototype.hasOwnProperty.call(files, name) || projectEntries.some(entry => entry.path === name)) {
      setMessage("That file already exists."); return;
    }
    if (isTauri() && projectRoot) {
      try {
        await invoke("write_project_file", { path: name, content: "" });
        setFiles(current => ({ ...current, [name]: "" }));
        setFileName(name); setDraftName(""); setNewFile(false); setPanel("Explorer");
        await refreshProject();
        setMessage("Created project file " + name);
        return;
      } catch (error) {
        setMessage("Could not create project file: " + String(error)); return;
      }
    }
    setFiles(current => ({ ...current, [name]: "" }));
    setFileName(name); setDraftName(""); setNewFile(false); setPanel("Explorer");
    setMessage("Created browser-workspace file " + name);
  }
  function removeFile(name: string) {
    if (name === "Welcome.md") { setMessage("The welcome file is kept as a starter."); return; }
    setFiles(current => {
      const next = { ...current }; delete next[name]; return next;
    });
    if (fileName === name) setFileName("Welcome.md");
    setMessage("Removed " + name + " from this browser workspace.");
  }
  function openFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length) return;

    const eligible = selected.filter(file =>
      isValidRelativeFileName(file.name) && isWithinTextImportLimit(file.size)
    );
    const accepted = eligible.slice(0, MAX_WORKSPACE_FILES);
    const skipped = selected.length - accepted.length;
    if (skipped > 0) {
      setMessage(`Skipped ${skipped} file(s): invalid filename, over 2 MB, or import batch limit reached.`);
    }
    if (!accepted.length) return;

    let remaining = accepted.length;
    let failed = 0;
    const imported: Workspace = {};
    const finish = () => {
      remaining -= 1;
      if (remaining !== 0) return;
      const safeImported = sanitizeWorkspaceFiles(imported);
      const merged = sanitizeWorkspaceFiles({ ...files, ...safeImported });
      setFiles(merged);
      const importedNames = Object.keys(safeImported).filter(name =>
        Object.prototype.hasOwnProperty.call(merged, name) && merged[name] === safeImported[name]
      );
      const lastImported = [...importedNames].reverse().find(name => name in merged);
      if (lastImported) setFileName(lastImported);
      setPanel("Explorer");
      if (failed > 0) {
        setMessage(`Imported ${importedNames.length} file(s); ${failed} file(s) could not be read.`);
      } else {
        setMessage(`Imported ${importedNames.length} file(s) into the browser workspace.`);
      }
    };

    for (const file of accepted) {
      const reader = new FileReader();
      reader.onload = () => {
        const body = String(reader.result ?? "");
        if (body.length <= MAX_WORKSPACE_FILE_CHARS) imported[file.name] = body;
        else failed += 1;
        finish();
      };
      reader.onerror = () => {
        failed += 1;
        finish();
      };
      reader.readAsText(file);
    }
  }
  function exportWorkspace() {
    download("gocode-workspace.json", JSON.stringify({ app: "Gocode IDE", version: 1, files }, null, 2), "application/json");
    setMessage("Workspace backup downloaded.");
  }
  function importWorkspace(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > MAX_WORKSPACE_BACKUP_BYTES) {
      setMessage("Workspace backup exceeds the 20 MB import limit.");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const value: unknown = JSON.parse(String(reader.result));
        if (!value || typeof value !== "object" || !("files" in value) ||
            !value.files || typeof value.files !== "object" || Array.isArray(value.files)) throw new Error("Invalid backup");
        const result = sanitizeWorkspaceFiles(value.files);
        if (!Object.keys(result).length) throw new Error("Empty backup");
        setFiles(result); setFileName(Object.keys(result)[0]); setMessage("Workspace backup imported.");
      } catch { setMessage("Could not import that workspace backup."); }
    };
    reader.readAsText(file); event.target.value = "";
  }
  function replaceAll() {
    if (!findText) { setMessage("Enter text to find first."); return; }
    setFiles(current => ({ ...current, [fileName]: (current[fileName] ?? "").split(findText).join(replaceText) }));
    setMessage("Replace all finished in " + fileName);
  }

  return <div className="app">
    <header className="titlebar"><div className="brand"><img className="brand-logo" src="/gocode-logo.svg" alt="" /><span>Gocode <b>IDE</b></span></div><div className="title-center">Workspace <span className="muted">/</span> my-project</div><div className="window-actions"><span>—</span><span>□</span><span>×</span></div></header>
    <div className="menubar"><button onClick={() => { setNewFile(true); setPanel("Explorer"); }}>New File</button><button onClick={() => { if (isTauri()) void openNativeFile(); else document.getElementById("open-files-input")?.click(); }}>Open File</button><button onClick={() => isTauri() ? void openProjectFolder() : setMessage("Open project folder is available in the desktop app.")}>Open Project</button><input id="open-files-input" type="file" multiple hidden onChange={openFiles} /><button onClick={() => void saveCurrentFile()}>Save File</button><button onClick={downloadFile}>Download File</button><button onClick={() => { setPanel("Search"); setShowFind(true); }}>Find / Replace</button><button onClick={() => setShowTerminal(v => !v)}>Terminal Panel</button><div className="menubar-right">Local-first · {projectRoot ? "Project open" : "No project"}</div></div>
    <div className="workarea">
      <nav className="activity">{panels.map(item => <button key={item.name} title={item.name} aria-label={item.name} className={panel === item.name ? "active" : ""} onClick={() => setPanel(item.name)}><span>{item.icon}</span></button>)}</nav>
      <aside className="sidebar"><div className="side-heading">{panel.toUpperCase()}<button title="New file" onClick={() => { setNewFile(true); setPanel("Explorer"); }}>＋</button></div>
        {panel === "Explorer" ? <>
          <div className="tree-heading">⌄　{projectRoot ? projectRoot.split(/[\\\\/]/).pop() : "MY-PROJECT"} <button title="New file" onClick={() => setNewFile(true)}>＋</button></div>{projectRoot && <div className="project-root-label" title={projectRoot}>{projectRoot}</div>}{projectRoot && projectEntries.map(entry => <div className={"file-row project-row " + (fileName === entry.path ? "selected" : "")} key={entry.path} style={{ paddingLeft: Math.min(7 + (entry.path.split("/").length - 1) * 12, 60) }}><button className="file-open" onClick={() => entry.is_dir ? undefined : void openProjectEntry(entry.path)}><span className="file-icon">{entry.is_dir ? "▸" : "◇"}</span>{entry.path.split("/").pop()}</button></div>)}
          {Object.keys(files).sort().map(name => <div className={"file-row " + (fileName === name ? "selected" : "")} key={name}>
            <button className="file-open" onClick={() => setFileName(name)}><span className="file-icon">◇</span>{name}</button>
            <button className="file-delete" title={"Remove " + name} onClick={() => removeFile(name)}>×</button>
          </div>)}
          {newFile && <form onSubmit={createFile}><input autoFocus placeholder="filename.ext" value={draftName} onChange={e => setDraftName(e.target.value)} /><div className="form-actions"><button type="submit">Create</button><button type="button" onClick={() => setNewFile(false)}>Cancel</button></div></form>}
          <div className="workspace-actions"><button onClick={exportWorkspace}>Export workspace backup</button><label className="import-button">Import backup<input type="file" accept=".json,application/json" onChange={importWorkspace} /></label></div>
        </> : panel === "Search" ? <div className="empty-panel"><label>Search workspace buffers</label><input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Text to find" />{searchTerm && matches.map(([name]) => <button className="search-result" key={name} onClick={() => { setFileName(name); setPanel("Explorer"); }}>{name}<small>Open buffer</small></button>)}<hr /><strong>Search opened project</strong><p>Searches text files up to 1 MB, skips symlinks and common generated folders, and returns at most 200 matches.</p><button disabled={!projectRoot || projectSearchBusy || !searchTerm.trim()} onClick={() => void searchProject()}>{projectSearchBusy ? "Searching…" : "Search project files"}</button>{projectSearchResults.map((result, index) => <button className="search-result" key={result.path + ":" + result.line_number + ":" + index} onClick={() => { void openProjectEntry(result.path).then(() => setMessage(`Opened ${result.path} (match on line ${result.line_number}).`)); }}><span>{result.path}:{result.line_number}</span><small>{result.snippet}</small></button>)}</div>
          : panel === "Source Control" ? <div className="empty-panel"><strong>Git Source Control</strong><p>{projectRoot ? "Project: " + projectRoot : "Open a project folder first."}</p><button disabled={!projectRoot || gitBusy} onClick={() => void refreshGit()}>Refresh status / diff</button><button disabled={!projectRoot || gitBusy} onClick={() => void stageGitChanges()}>Stage all changes</button><input aria-label="Commit message" placeholder="Commit message" value={commitMessage} onChange={e => setCommitMessage(e.target.value)} /><button disabled={!projectRoot || !commitMessage.trim() || gitBusy} onClick={() => void commitGitChanges()}>Commit staged changes</button><div className="git-branch-controls"><label>Local branch<select aria-label="Local branch" value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} disabled={!projectRoot || gitBusy}>{gitBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label><button disabled={!projectRoot || !selectedBranch || gitBusy || selectedBranch === gitInfo?.branch} onClick={() => void checkoutGitBranch()}>Switch branch</button></div><button disabled={!projectRoot || gitBusy} onClick={() => void syncGit("pull")}>Pull (fast-forward only)</button><button disabled={!projectRoot || gitBusy} onClick={() => void syncGit("push")}>Push current branch to origin</button>{gitInfo && <><p>Branch: {gitInfo.branch || "(detached HEAD)"}</p><pre className="output-box">{gitInfo.output}</pre><pre className="output-box">{gitDiff}</pre></>}{taskOutput && <pre className="output-box">{taskOutput}</pre>}<p>Git actions run locally. Pull/push require a configured remote and may use the credentials configured in Git. Remote sync asks for confirmation; branch switching only targets existing local branches.</p></div>
          : panel === "Run & Debug" ? <div className="empty-panel"><strong>Build &amp; Toolchains</strong><p>{projectRoot ? "Detected project tasks:" : "Open a project folder first."}</p>{tasks.map(task => <button key={task} disabled={!projectRoot || taskRunning} onClick={() => void runTask(task)}>{taskRunning ? "Running…" : "Run " + task}</button>)}{taskOutput && <pre className="output-box">{taskOutput}</pre>}<p>Runs fixed, detected build/test commands without shell interpolation. Install the relevant toolchain and make it available on PATH.</p><p>Interactive debugging is not implemented yet.</p></div>
          : panel === "Extensions" ? <div className="empty-panel"><strong>Extension manifest registry</strong><p>Import JSON to review an extension's identity, publisher, license, and requested capabilities. This prototype does not install or execute extension code.</p><label className="import-button">Import manifest JSON<input type="file" accept=".json,application/json" onChange={importExtensionManifest} /></label>{extensionError && <p role="status">{extensionError}</p>}{extensions.map(ext => <section className="extension-card" key={ext.id}><strong>{ext.name} <small>v{ext.version}</small></strong><p>{ext.description}</p><p>Publisher: {ext.publisher}</p><p>License: {ext.license}</p><p>Requested capabilities: {ext.capabilities.length ? ext.capabilities.join(", ") : "None declared"}</p><button onClick={() => setExtensions(old => old.filter(x => x.id !== ext.id))}>Remove manifest</button></section>)}<p>Manifest claims are not verified publisher identities or license compliance guarantees.</p></div>
          : <div className="empty-panel"><strong>Editor &amp; Privacy Settings</strong><label className="setting-row"><input type="checkbox" checked={wordWrap} onChange={e => setWordWrap(e.target.checked)} /> Word wrap</label><label className="setting-row"><input type="checkbox" checked={minimap} onChange={e => setMinimap(e.target.checked)} /> Editor minimap</label><p>Workspace buffers, editor preferences, and extension manifests are stored in this browser profile. Export a workspace backup before clearing browser data.</p><p>External project uploads are not performed by these features. Language-server intelligence, DAP debugging, and executable extension hosting still need implementation and security review.</p></div>}
      </aside>
      <main className="main"><div className="tabs"><div className="tab"><span className="file-icon">◇</span>{fileName}<button onClick={downloadFile} title="Download current file">↓</button></div><div className="editor-actions"><span>{lineCount} lines</span><button onClick={() => setShowTerminal(v => !v)} title="Toggle terminal">⌄</button></div></div>
        {showFind && <div className="findbar"><input aria-label="Find text" placeholder="Find text" value={findText} onChange={e => setFindText(e.target.value)} /><input aria-label="Replace text" placeholder="Replace with" value={replaceText} onChange={e => setReplaceText(e.target.value)} /><button onClick={replaceAll}>Replace all</button><button onClick={() => setShowFind(false)} title="Close find">×</button></div>}
        <div className="editor-wrap"><Editor height="100%" language={languageForFile(fileName)} value={text} theme="vs-dark" onValidate={markers => setEditorDiagnostics(markers.map(marker => ({ message: marker.message, lineNumber: marker.startLineNumber, column: marker.startColumn, severity: marker.severity })))} onChange={value => setFiles(current => ({ ...current, [fileName]: value ?? "" }))} options={{ automaticLayout: true, minimap: { enabled: minimap }, fontSize: 13, tabSize: 2, wordWrap: wordWrap ? "on" : "off", scrollBeyondLastLine: false, renderLineHighlight: "all", padding: { top: 14, bottom: 16 }, smoothScrolling: true, bracketPairColorization: { enabled: true } }} /></div>
        <div className={"bottom " + (!showTerminal ? "collapsed" : "")}><div className="bottom-tabs"><button className={bottomPanel === "problems" ? "bottom-active" : ""} onClick={() => setBottomPanel("problems")}>PROBLEMS <span>{editorDiagnostics.length}</span></button><button onClick={() => { setBottomPanel("terminal"); setShowTerminal(true); }}>TERMINAL</button><button className="push" onClick={() => setShowTerminal(false)}>×</button></div>{bottomPanel === "problems" ? <div className="terminal-body">{editorDiagnostics.length ? editorDiagnostics.map((item, index) => <button className="search-result" key={index} onClick={() => setMessage(`${fileName}:${item.lineNumber}:${item.column} — ${item.message}`)}><strong>{item.severity === 8 ? "Error" : item.severity === 4 ? "Warning" : "Info"}</strong> {item.message}<small>{fileName}:{item.lineNumber}:{item.column}</small></button>) : <div className="terminal-note">No diagnostics reported by the editor for this file. Full language-server diagnostics are not yet implemented.</div>}</div> : showTerminal && (isTauri() ? <div className="terminal-host" ref={terminalHost} /> : <div className="terminal-body"><div><span className="prompt">›</span> Gocode IDE browser prototype</div><div className="terminal-note">A real system terminal is available in the installed desktop app. The browser preview cannot access your system shell.</div></div>)}</div>
      </main>
    </div>
    <footer><span>● {message}</span><span>Browser storage</span><span>UTF-8</span><span>Ctrl+S Download · Ctrl+N New · Ctrl+F Find</span><span className="push">Gocode IDE · Free and local-first</span></footer>
  </div>;
}
