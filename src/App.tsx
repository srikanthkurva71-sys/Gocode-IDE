import { useEffect, useMemo, useState, type FormEvent, type ChangeEvent } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { clampEditorFontSize, filterQuickOpenNames, findWorkspaceMatches, formatTaskOutput, isValidRelativeFileName, isWithinTextImportLimit, MAX_WORKSPACE_BACKUP_BYTES, MAX_WORKSPACE_FILES, MAX_WORKSPACE_FILE_CHARS, mergeWorkspaceFiles, sanitizeWorkspaceFiles } from "./lib/workspace";

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
  const [savedProjectContents, setSavedProjectContents] = useState<Record<string, string>>({});
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [collapsedProjectDirs, setCollapsedProjectDirs] = useState<Record<string, boolean>>({});
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
  const [fontSize, setFontSize] = useState<number>(() => { try { const value = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || "{}").fontSize; return Number.isInteger(value) && value >= 10 && value <= 24 ? clampEditorFontSize(value) : 13; } catch { return 13; } });
  const [fileName, setFileName] = useState("Welcome.md");
  const [openTabs, setOpenTabs] = useState<string[]>(["Welcome.md"]);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [draftName, setDraftName] = useState("");
  const [newFile, setNewFile] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [draftFolderName, setDraftFolderName] = useState("");
  const [showTerminal, setShowTerminal] = useState(true);
  const terminalHost = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [pendingCursor, setPendingCursor] = useState<{ path: string; line: number } | null>(null);
  const [message, setMessage] = useState("Ready");
  const [editorDiagnostics, setEditorDiagnostics] = useState<EditorDiagnostic[]>([]);
  const [lspSessionId, setLspSessionId] = useState<string | null>(null);
  const [lspReady, setLspReady] = useState(false);
  const [bottomPanel, setBottomPanel] = useState<"problems" | "terminal">("terminal");
  const [searchTerm, setSearchTerm] = useState("");
  const [projectSearchResults, setProjectSearchResults] = useState<ProjectSearchResult[]>([]);
  const [projectSearchBusy, setProjectSearchBusy] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showFind, setShowFind] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [quickOpenSelectedIndex, setQuickOpenSelectedIndex] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0);
  const text = files[fileName] ?? "";
  const lspDocumentRef = useRef({ fileName, text, projectRoot });
  lspDocumentRef.current = { fileName, text, projectRoot };
  const paletteCommands: { id: string; label: string; run: () => void }[] = [
    { id: "open-project", label: "Open Project Folder", run: () => void openProjectFolder() },
    { id: "save-file", label: "Save Current File", run: () => void saveCurrentFile() },
    { id: "save-all", label: "Save All Open Project Files", run: () => void saveAllOpenProjectFiles() },
    { id: "quick-open", label: "Quick Open File", run: () => { setQuickOpenQuery(""); setQuickOpen(true); } },
    { id: "find", label: "Find / Replace", run: () => { setPanel("Search"); setShowFind(true); } },
    { id: "terminal", label: "Toggle Terminal Panel", run: () => setShowTerminal(value => !value) },
    ...panels.map(item => ({ id: "panel-" + item.name, label: "Show " + item.name, run: () => setPanel(item.name) }))
  ];
  const commandNeedle = commandQuery.trim().toLowerCase();
  const filteredCommands = paletteCommands.filter(command => !commandNeedle || command.label.toLowerCase().includes(commandNeedle)).slice(0, 50);
  function runPaletteCommand(command: { id: string; label: string; run: () => void }) {
    setCommandPaletteOpen(false);
    command.run();
    setMessage("Command: " + command.label);
  }

  const quickOpenEntries = useMemo(() => {
    const names = new Set(Object.keys(files));
    for (const entry of projectEntries) if (!entry.is_dir) names.add(entry.path);
    return filterQuickOpenNames(names, quickOpenQuery, 100);
  }, [files, projectEntries, quickOpenQuery]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);

  function projectFileUri(root: string, relative: string): string {
    const absolute = (root.replace(/\\/g, "/").replace(/\/$/, "") + "/" + relative.replace(/\\/g, "/"));
    return "file:///" + absolute.split("/").filter(Boolean).map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");
  }

  async function startLanguageServer() {
    if (!isTauri()) { setMessage("Language servers are available only in the installed desktop app."); return; }
    if (!projectRoot) { setMessage("Open a native project folder before starting a language server."); return; }
    const executable = window.prompt("Enter the full path to a language-server executable you installed and trust:");
    if (!executable?.trim()) return;
    const rawArgs = window.prompt("Optional executable arguments, separated by spaces (leave blank for none):", "") ?? "";
    const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
    try {
      if (lspSessionId) await invoke("lsp_stop", { sessionId: lspSessionId });
      const rootUri = projectFileUri(projectRoot, "").replace(/\/$/, "");
      const id = await invoke<string>("lsp_start", { executable: executable.trim(), args, rootUri });
      setLspSessionId(id);
      setLspReady(false);
      setMessage("Language server started; waiting for initialization.");
    } catch (error) { setMessage("Could not start language server: " + String(error)); }
  }

  async function stopLanguageServer() {
    if (!lspSessionId) return;
    try { await invoke("lsp_stop", { sessionId: lspSessionId }); }
    catch (error) { setMessage("Language-server stop failed: " + String(error)); }
    setLspSessionId(null);
    setLspReady(false);
    setEditorDiagnostics([]);
    setMessage("Language server stopped.");
  }

  const lspDocumentVersion = useRef(1);
  useEffect(() => {
    if (!lspReady || !lspSessionId || !projectRoot) return;
    const uri = projectFileUri(projectRoot, fileName);
    const version = ++lspDocumentVersion.current;
    void invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } } })
      .catch(error => setMessage("Could not synchronize document with language server: " + String(error)));
  }, [text, fileName, projectRoot, lspReady, lspSessionId]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlistenMessage: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let active = true;
    void Promise.all([
      listen<{ session_id: string; message: Record<string, unknown> }>("lsp-message", async event => {
        const payload = event.payload;
        if (!active || payload.session_id !== lspSessionId) return;
        const message = payload.message;
        if (message.id === 1 && message.result && !lspReady) {
          try {
            await invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "initialized", params: {} } });
            const doc = lspDocumentRef.current;
            if (doc.projectRoot) {
              const uri = projectFileUri(doc.projectRoot, doc.fileName);
              await invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: languageForFile(doc.fileName), version: 1, text: doc.text } } } });
              setLspReady(true);
              setMessage("Language server initialized for " + doc.fileName + ".");
            }
          } catch (error) { setMessage("Language-server initialization failed: " + String(error)); }
        }
        if (message.method === "textDocument/publishDiagnostics") {
          const params = message.params as { uri?: string; diagnostics?: Array<{ message?: string; range?: { start?: { line?: number; character?: number } }; severity?: number }> } | undefined;
          const doc = lspDocumentRef.current;
          if (params?.uri && doc.projectRoot && params.uri === projectFileUri(doc.projectRoot, doc.fileName)) {
            setEditorDiagnostics((params.diagnostics ?? []).map(item => ({ message: item.message ?? "Language-server diagnostic", lineNumber: (item.range?.start?.line ?? 0) + 1, column: (item.range?.start?.character ?? 0) + 1, severity: item.severity === 1 ? 8 : item.severity === 2 ? 4 : 2 })));
          }
        }
      }),
      listen<{ session_id: string; message: string }>("lsp-error", event => {
        if (active && event.payload.session_id === lspSessionId) setMessage("Language-server error: " + event.payload.message);
      }),
      listen<{ session_id: string }>("lsp-exited", event => {
        if (active && event.payload.session_id === lspSessionId) { setLspReady(false); setMessage("Language server exited."); }
      })
    ]).then(([message, error, exited]) => {
      if (!active) { message(); error(); exited(); return; }
      unlistenMessage = message; unlistenError = error; unlistenExit = exited;
    });
    return () => { active = false; unlistenMessage?.(); unlistenError?.(); unlistenExit?.(); };
  }, [lspSessionId, lspReady]);

  useEffect(() => {
    setOpenTabs(current => current.includes(fileName) ? current : [...current, fileName]);
  }, [fileName]);

  function isProjectTabDirty(name: string): boolean {
    return projectEntries.some(entry => entry.path === name && !entry.is_dir) && Object.prototype.hasOwnProperty.call(savedProjectContents, name) && (files[name] ?? "") !== savedProjectContents[name];
  }

  function closeEditorTab(name: string) {
    if (isProjectTabDirty(name) && !window.confirm("\u201c" + name + "\u201d has unsaved changes. Close this tab anyway?")) return;
    setOpenTabs(current => {
      const next = current.filter(tab => tab !== name);
      if (fileName === name) {
        const fallback = next[next.length - 1] ?? "Welcome.md";
        setFileName(fallback);
        if (!next.length) return ["Welcome.md"];
      }
      return next.length ? next : ["Welcome.md"];
    });
    setMessage("Closed editor tab " + name + ". The file was not deleted.");
  }

  useEffect(() => {
    if (!pendingCursor || pendingCursor.path !== fileName || !editorRef.current) return;
    const line = Math.max(1, Math.min(pendingCursor.line, editorRef.current.getModel()?.getLineCount() ?? 1));
    editorRef.current.revealLineInCenter(line);
    editorRef.current.setPosition({ lineNumber: line, column: 1 });
    editorRef.current.focus();
    setPendingCursor(null);
  }, [pendingCursor, fileName, text]);
  const matches = useMemo(() => findWorkspaceMatches(files, searchTerm), [files, searchTerm]);

  useEffect(() => { setQuickOpenSelectedIndex(0); }, [quickOpenQuery, quickOpen]);
  useEffect(() => { setCommandSelectedIndex(0); }, [commandQuery, commandPaletteOpen]);

  useEffect(() => {
    try { localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(extensions)); }
    catch { setExtensionError("Could not save extension manifest list in browser storage."); }
  }, [extensions]);

  useEffect(() => {
    try { localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify({ wordWrap, minimap, fontSize })); }
    catch { /* Settings remain active for this session. */ }
  }, [wordWrap, minimap, fontSize]);

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

  function openQuickOpenEntry(name: string) {
    setQuickOpen(false);
    if (projectRoot && projectEntries.some(entry => entry.path === name && !entry.is_dir)) {
      void openProjectEntry(name);
    } else {
      setFileName(name);
      setPanel("Explorer");
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (commandPaletteOpen && event.key === "ArrowDown") {
        event.preventDefault(); setCommandSelectedIndex(index => Math.min(index + 1, Math.max(0, filteredCommands.length - 1))); return;
      } else if (commandPaletteOpen && event.key === "ArrowUp") {
        event.preventDefault(); setCommandSelectedIndex(index => Math.max(0, index - 1)); return;
      } else if (commandPaletteOpen && event.key === "Enter" && filteredCommands[commandSelectedIndex]) {
        event.preventDefault(); runPaletteCommand(filteredCommands[commandSelectedIndex]); return;
      } else if (commandPaletteOpen && event.key === "Escape") {
        setCommandPaletteOpen(false); return;
      } else if (quickOpen && event.key === "ArrowDown") {
        event.preventDefault();
        setQuickOpenSelectedIndex(index => Math.min(index + 1, Math.max(0, quickOpenEntries.length - 1)));
        return;
      } else if (quickOpen && event.key === "ArrowUp") {
        event.preventDefault();
        setQuickOpenSelectedIndex(index => Math.max(0, index - 1));
        return;
      } else if (quickOpen && event.key === "Enter" && quickOpenEntries[quickOpenSelectedIndex]) {
        event.preventDefault();
        openQuickOpenEntry(quickOpenEntries[quickOpenSelectedIndex]);
        return;
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w" && openTabs.includes(fileName)) {
        event.preventDefault();
        closeEditorTab(fileName);
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Tab" && openTabs.length > 1) {
        event.preventDefault();
        const currentIndex = openTabs.indexOf(fileName);
        const nextIndex = (currentIndex + 1) % openTabs.length;
        setFileName(openTabs[nextIndex]);
      } else if ((event.ctrlKey || event.metaKey) && (event.key === "=" || event.key === "+")) {
        event.preventDefault(); setFontSize(size => clampEditorFontSize(size + 1));
      } else if ((event.ctrlKey || event.metaKey) && event.key === "-") {
        event.preventDefault(); setFontSize(size => clampEditorFontSize(size - 1));
      } else if ((event.ctrlKey || event.metaKey) && event.key === "0") {
        event.preventDefault(); setFontSize(13);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        const rawLine = window.prompt("Go to line number:", String(editorRef.current?.getPosition()?.lineNumber ?? 1));
        if (rawLine !== null && /^\s*\d+\s*$/.test(rawLine) && editorRef.current) {
          const line = Number(rawLine.trim());
          const maxLine = editorRef.current.getModel()?.getLineCount() ?? 1;
          if (line >= 1 && line <= maxLine) {
            editorRef.current.revealLineInCenter(line);
            editorRef.current.setPosition({ lineNumber: line, column: 1 });
            editorRef.current.focus();
            setMessage("Moved to line " + line + ".");
          } else setMessage("Line number must be between 1 and " + maxLine + ".");
        } else if (rawLine !== null) setMessage("Enter a valid positive line number.");
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); void saveCurrentFile();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault(); setPanel("Explorer"); setNewFile(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); setPanel("Search"); setShowFind(true);
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault(); setCommandQuery(""); setCommandPaletteOpen(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
        event.preventDefault(); setQuickOpenQuery(""); setQuickOpen(true);
      } else if (event.key === "Escape") {
        setQuickOpen(false);
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
  function isProjectEntryVisible(entry: ProjectEntry): boolean {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (collapsedProjectDirs[parts.slice(0, index).join("/")]) return false;
    }
    return true;
  }
  function toggleProjectDirectory(path: string) {
    setCollapsedProjectDirs(current => ({ ...current, [path]: !current[path] }));
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
    if (isProjectTabDirty(path) && !window.confirm("\u201c" + path + "\u201d has unsaved changes. Reload from disk and discard them?")) return;
    try {
      const contents = await invoke<string>("read_project_file", { path });
      setFiles(current => ({ ...current, [path]: contents }));
      setSavedProjectContents(current => ({ ...current, [path]: contents }));
      setFileName(path);
      setPanel("Explorer");
      setMessage("Opened project file " + path);
    } catch (error) { setMessage("Open project file failed: " + String(error)); }
  }
  async function saveProjectFile() {
    try {
      await invoke("write_project_file", { path: fileName, content: text });
      setSavedProjectContents(current => ({ ...current, [fileName]: text }));
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
  async function runCurrentSourceFile() {
    if (!projectRoot || !projectEntries.some(entry => entry.path === fileName && !entry.is_dir)) {
      setMessage("Open a source file from the native project Explorer first."); return;
    }
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    if (!["py", "js", "mjs", "cjs", "go"].includes(extension)) {
      setMessage("Run File currently supports Python, JavaScript, and Go."); return;
    }
    if (!window.confirm("Run " + fileName + " from the opened project? This executes project code locally. Continue only if you trust this file.")) {
      setMessage("Run File cancelled."); return;
    }
    setTaskRunning(true); setTaskOutput("Running " + fileName + " …");
    try {
      const result = await invoke<TaskResult>("run_source_file", { path: fileName });
      setTaskOutput(formatTaskOutput(result.success, result.command, result.output));
      setMessage(result.success ? "Run completed for " + fileName : "Run failed for " + fileName);
    } catch (error) { setTaskOutput("Could not run file: " + String(error)); setMessage("Run File failed to start."); }
    finally { setTaskRunning(false); }
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
  async function saveAllOpenProjectFiles() {
    const dirty = openTabs.filter(name => isProjectTabDirty(name));
    if (!dirty.length) { setMessage("All open project tabs are saved."); return; }
    if (!window.confirm("Save changes to " + dirty.length + " open project file(s)?")) return;
    setGitBusy(true);
    let saved = 0;
    try {
      for (const name of dirty) {
        const body = files[name] ?? "";
        await invoke("write_project_file", { path: name, content: body });
        setSavedProjectContents(current => ({ ...current, [name]: body }));
        saved += 1;
      }
      setMessage("Saved " + saved + " open project file(s).");
      await refreshProject();
    } catch (error) {
      setMessage("Saved " + saved + " file(s); save stopped: " + String(error));
    } finally { setGitBusy(false); }
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
        setSavedProjectContents(current => ({ ...current, [name]: "" }));
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
  async function createProjectFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = draftFolderName.trim();
    if (!projectRoot || !isTauri()) {
      setMessage("Open a project folder in the desktop app before creating folders.");
      return;
    }
    if (!isValidRelativeFileName(path)) {
      setMessage("Enter a valid relative folder path.");
      return;
    }
    if (projectEntries.some(entry => entry.path === path) || Object.prototype.hasOwnProperty.call(files, path)) {
      setMessage("A file or folder already exists at that path.");
      return;
    }
    try {
      await invoke("create_project_directory", { path });
      setCollapsedProjectDirs(current => {
        const next = { ...current };
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) delete next[parts.slice(0, index).join("/")];
        return next;
      });
      setDraftFolderName("");
      setNewFolder(false);
      await refreshProject();
      setMessage("Created project folder " + path);
    } catch (error) {
      setMessage("Could not create project folder: " + String(error));
    }
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
      const merged = mergeWorkspaceFiles(files, safeImported);
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
          <div className="tree-heading">⌄　{projectRoot ? projectRoot.split(/[\\\\/]/).pop() : "MY-PROJECT"} <button title="New folder" disabled={!projectRoot || !isTauri()} onClick={() => { setNewFolder(true); setNewFile(false); }}>▱</button><button title="New file" onClick={() => { setNewFile(true); setNewFolder(false); }}>＋</button></div>{projectRoot && <div className="project-root-label" title={projectRoot}>{projectRoot}</div>}{projectRoot && projectEntries.filter(isProjectEntryVisible).map(entry => <div className={"file-row project-row " + (fileName === entry.path ? "selected" : "")} key={entry.path} style={{ paddingLeft: Math.min(7 + (entry.path.split("/").length - 1) * 12, 60) }}><button className="file-open" aria-expanded={entry.is_dir ? !collapsedProjectDirs[entry.path] : undefined} onClick={() => entry.is_dir ? toggleProjectDirectory(entry.path) : void openProjectEntry(entry.path)}><span className="file-icon">{entry.is_dir ? (collapsedProjectDirs[entry.path] ? "▸" : "▾") : "◇"}</span>{entry.path.split("/").pop()}</button></div>)}
          {Object.keys(files).sort().map(name => <div className={"file-row " + (fileName === name ? "selected" : "")} key={name}>
            <button className="file-open" onClick={() => setFileName(name)}><span className="file-icon">◇</span>{name}</button>
            <button className="file-delete" title={"Remove " + name} onClick={() => removeFile(name)}>×</button>
          </div>)}
          {newFile && <form onSubmit={createFile}><input autoFocus placeholder="filename.ext" value={draftName} onChange={e => setDraftName(e.target.value)} /><div className="form-actions"><button type="submit">Create</button><button type="button" onClick={() => setNewFile(false)}>Cancel</button></div></form>}{newFolder && <form onSubmit={createProjectFolder}><input autoFocus placeholder="folder-name or parent/child" aria-label="Folder path" value={draftFolderName} onChange={e => setDraftFolderName(e.target.value)} /><div className="form-actions"><button type="submit">Create folder</button><button type="button" onClick={() => setNewFolder(false)}>Cancel</button></div></form>}
          <div className="workspace-actions"><button onClick={exportWorkspace}>Export workspace backup</button><label className="import-button">Import backup<input type="file" accept=".json,application/json" onChange={importWorkspace} /></label></div>
        </> : panel === "Search" ? <div className="empty-panel"><label>Search workspace buffers</label><input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Text to find" />{searchTerm && matches.map(([name]) => <button className="search-result" key={name} onClick={() => { setFileName(name); setPanel("Explorer"); }}>{name}<small>Open buffer</small></button>)}<hr /><strong>Search opened project</strong><p>Searches text files up to 1 MB, skips symlinks and common generated folders, and returns at most 200 matches.</p><button disabled={!projectRoot || projectSearchBusy || !searchTerm.trim()} onClick={() => void searchProject()}>{projectSearchBusy ? "Searching…" : "Search project files"}</button>{projectSearchResults.map((result, index) => <button className="search-result" key={result.path + ":" + result.line_number + ":" + index} onClick={() => { setPendingCursor({ path: result.path, line: result.line_number }); void openProjectEntry(result.path).then(() => setMessage(`Opened ${result.path} at line ${result.line_number}.`)); }}><span>{result.path}:{result.line_number}</span><small>{result.snippet}</small></button>)}</div>
          : panel === "Source Control" ? <div className="empty-panel"><strong>Git Source Control</strong><p>{projectRoot ? "Project: " + projectRoot : "Open a project folder first."}</p><button disabled={!projectRoot || gitBusy} onClick={() => void refreshGit()}>Refresh status / diff</button><button disabled={!projectRoot || gitBusy} onClick={() => void stageGitChanges()}>Stage all changes</button><input aria-label="Commit message" placeholder="Commit message" value={commitMessage} onChange={e => setCommitMessage(e.target.value)} /><button disabled={!projectRoot || !commitMessage.trim() || gitBusy} onClick={() => void commitGitChanges()}>Commit staged changes</button><div className="git-branch-controls"><label>Local branch<select aria-label="Local branch" value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} disabled={!projectRoot || gitBusy}>{gitBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label><button disabled={!projectRoot || !selectedBranch || gitBusy || selectedBranch === gitInfo?.branch} onClick={() => void checkoutGitBranch()}>Switch branch</button></div><button disabled={!projectRoot || gitBusy} onClick={() => void syncGit("pull")}>Pull (fast-forward only)</button><button disabled={!projectRoot || gitBusy} onClick={() => void syncGit("push")}>Push current branch to origin</button>{gitInfo && <><p>Branch: {gitInfo.branch || "(detached HEAD)"}</p><pre className="output-box">{gitInfo.output}</pre><pre className="output-box">{gitDiff}</pre></>}{taskOutput && <pre className="output-box">{taskOutput}</pre>}<p>Git actions run locally. Pull/push require a configured remote and may use the credentials configured in Git. Remote sync asks for confirmation; branch switching only targets existing local branches.</p></div>
          : panel === "Run & Debug" ? <div className="empty-panel"><strong>Build &amp; Toolchains</strong><section className="extension-card"><strong>Language Server Protocol</strong><p>{lspSessionId ? (lspReady ? "Connected and initialized." : "Starting / initializing…") : "No language server connected."} Configure a local language-server executable you installed and trust. The IDE will launch it only after you press Start.</p><button disabled={!projectRoot || !isTauri()} onClick={() => void startLanguageServer()}>Start Language Server…</button><button disabled={!lspSessionId} onClick={() => void stopLanguageServer()}>Stop Language Server</button></section><p>{projectRoot ? "Detected project tasks:" : "Open a project folder first."}</p><button disabled={!projectRoot || taskRunning || !projectEntries.some(entry => entry.path === fileName && !entry.is_dir)} onClick={() => void runCurrentSourceFile()}>Run Current File (Python / JS / Go)</button>{tasks.map(task => <button key={task} disabled={!projectRoot || taskRunning} onClick={() => void runTask(task)}>{taskRunning ? "Running…" : "Run " + task}</button>)}{taskOutput && <pre className="output-box">{taskOutput}</pre>}<p>Runs fixed, detected build/test commands without shell interpolation. Install the relevant toolchain and make it available on PATH.</p><p>Interactive debugging is not implemented yet.</p></div>
          : panel === "Extensions" ? <div className="empty-panel"><strong>Extension manifest registry</strong><p>Import JSON to review an extension's identity, publisher, license, and requested capabilities. This prototype does not install or execute extension code.</p><label className="import-button">Import manifest JSON<input type="file" accept=".json,application/json" onChange={importExtensionManifest} /></label>{extensionError && <p role="status">{extensionError}</p>}{extensions.map(ext => <section className="extension-card" key={ext.id}><strong>{ext.name} <small>v{ext.version}</small></strong><p>{ext.description}</p><p>Publisher: {ext.publisher}</p><p>License: {ext.license}</p><p>Requested capabilities: {ext.capabilities.length ? ext.capabilities.join(", ") : "None declared"}</p><button onClick={() => setExtensions(old => old.filter(x => x.id !== ext.id))}>Remove manifest</button></section>)}<p>Manifest claims are not verified publisher identities or license compliance guarantees.</p></div>
          : <div className="empty-panel"><strong>Editor &amp; Privacy Settings</strong><label className="setting-row"><input type="checkbox" checked={wordWrap} onChange={e => setWordWrap(e.target.checked)} /> Word wrap</label><label className="setting-row"><input type="checkbox" checked={minimap} onChange={e => setMinimap(e.target.checked)} /> Editor minimap</label><label className="setting-row">Editor font size <input aria-label="Editor font size" type="number" min={10} max={24} value={fontSize} onChange={event => setFontSize(clampEditorFontSize(Number(event.target.value)))} /></label><p>Use Ctrl+= / Ctrl+- to change font size and Ctrl+0 to reset it. The size is saved with editor preferences.</p><p>Workspace buffers, editor preferences, and extension manifests are stored in this browser profile. Export a workspace backup before clearing browser data.</p><p>External project uploads are not performed by these features. Language-server intelligence, DAP debugging, and executable extension hosting still need implementation and security review.</p></div>}
      </aside>
      <main className="main"><div className="tabs">{openTabs.map(name => <div key={name} className={"tab " + (fileName === name ? "tab-active" : "tab-inactive")} onClick={() => setFileName(name)} title={name}><span className="file-icon">◇</span><span className="tab-name">{name}</span>{isProjectTabDirty(name) && <span className="tab-dirty" title="Unsaved project changes" aria-label="Unsaved changes">●</span>}<button className="tab-close" aria-label={"Close " + name} title={"Close " + name} onClick={event => { event.stopPropagation(); closeEditorTab(name); }}>×</button></div>)}<div className="editor-actions"><span>{lineCount} lines</span><button onClick={() => void saveAllOpenProjectFiles()} disabled={gitBusy || !openTabs.some(isProjectTabDirty)} title="Save all modified open project files">Save All</button><button onClick={downloadFile} title="Download current file">↓</button><button onClick={() => setShowTerminal(v => !v)} title="Toggle terminal">⌄</button></div></div>
        {showFind && <div className="findbar"><input aria-label="Find text" placeholder="Find text" value={findText} onChange={e => setFindText(e.target.value)} /><input aria-label="Replace text" placeholder="Replace with" value={replaceText} onChange={e => setReplaceText(e.target.value)} /><button onClick={replaceAll}>Replace all</button><button onClick={() => setShowFind(false)} title="Close find">×</button></div>}
        <div className="editor-wrap"><Editor height="100%" onMount={editor => { editorRef.current = editor; setCursorPosition({ line: editor.getPosition()?.lineNumber ?? 1, column: editor.getPosition()?.column ?? 1 }); editor.onDidChangeCursorPosition(event => setCursorPosition({ line: event.position.lineNumber, column: event.position.column })); }} language={languageForFile(fileName)} value={text} theme="vs-dark" onValidate={markers => setEditorDiagnostics(markers.map(marker => ({ message: marker.message, lineNumber: marker.startLineNumber, column: marker.startColumn, severity: marker.severity })))} onChange={value => setFiles(current => ({ ...current, [fileName]: value ?? "" }))} options={{ automaticLayout: true, minimap: { enabled: minimap }, fontSize, tabSize: 2, wordWrap: wordWrap ? "on" : "off", scrollBeyondLastLine: false, renderLineHighlight: "all", padding: { top: 14, bottom: 16 }, smoothScrolling: true, bracketPairColorization: { enabled: true } }} /></div>
        <div className={"bottom " + (!showTerminal ? "collapsed" : "")}><div className="bottom-tabs"><button className={bottomPanel === "problems" ? "bottom-active" : ""} onClick={() => setBottomPanel("problems")}>PROBLEMS <span>{editorDiagnostics.length}</span></button><button onClick={() => { setBottomPanel("terminal"); setShowTerminal(true); }}>TERMINAL</button><button className="push" onClick={() => setShowTerminal(false)}>×</button></div>{bottomPanel === "problems" ? <div className="terminal-body">{editorDiagnostics.length ? editorDiagnostics.map((item, index) => <button className="search-result" key={index} onClick={() => { editorRef.current?.revealLineInCenter(item.lineNumber); editorRef.current?.setPosition({ lineNumber: item.lineNumber, column: item.column }); editorRef.current?.focus(); setMessage(`${fileName}:${item.lineNumber}:${item.column} — ${item.message}`); }}><strong>{item.severity === 8 ? "Error" : item.severity === 4 ? "Warning" : "Info"}</strong> {item.message}<small>{fileName}:{item.lineNumber}:{item.column}</small></button>) : <div className="terminal-note">No diagnostics reported by the editor for this file. Full language-server diagnostics are not yet implemented.</div>}</div> : showTerminal && (isTauri() ? <div className="terminal-host" ref={terminalHost} /> : <div className="terminal-body"><div><span className="prompt">›</span> Gocode IDE browser prototype</div><div className="terminal-note">A real system terminal is available in the installed desktop app. The browser preview cannot access your system shell.</div></div>)}</div>
      </main>
    </div>
    {commandPaletteOpen && <div className="quick-open-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCommandPaletteOpen(false); }}>
      <section className="quick-open-dialog command-palette" role="dialog" aria-modal="true" aria-label="Command Palette">
        <input autoFocus aria-label="Search commands" placeholder="Type a command…" value={commandQuery} onChange={event => setCommandQuery(event.target.value)} />
        <div className="quick-open-results">{filteredCommands.map((command, index) => <button key={command.id} className={index === commandSelectedIndex ? "quick-open-selected" : ""} onMouseEnter={() => setCommandSelectedIndex(index)} onClick={() => runPaletteCommand(command)}><span>›</span><span>{command.label}</span></button>)}
          {!filteredCommands.length && <p>No matching commands.</p>}
        </div><small>Ctrl+Shift+P to open · ↑ ↓ to navigate · Enter to run · Esc to close</small>
      </section>
    </div>}
    {quickOpen && <div className="quick-open-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setQuickOpen(false); }}>
      <section className="quick-open-dialog" role="dialog" aria-modal="true" aria-label="Quick Open">
        <input autoFocus aria-label="Search files by name" placeholder="Type a file name to open…" value={quickOpenQuery} onChange={event => setQuickOpenQuery(event.target.value)} />
        <div className="quick-open-results">{quickOpenEntries.map(name => <button key={name} className={quickOpenEntries[quickOpenSelectedIndex] === name ? "quick-open-selected" : ""} onMouseEnter={() => setQuickOpenSelectedIndex(quickOpenEntries.indexOf(name))} onClick={() => openQuickOpenEntry(name)}><span>◇</span><span>{name}</span></button>)}
          {!quickOpenEntries.length && <p>No matching files.</p>}
        </div>
        <small>Ctrl+P to open · Esc to close · Showing up to 100 files</small>
      </section>
    </div>}
    <footer><span>● {message}</span><span>Browser storage</span><span>UTF-8</span><span>{languageForFile(fileName)} · Ln {cursorPosition.line}, Col {cursorPosition.column}</span><span>Ctrl+S Save · Ctrl+N New · Ctrl+W Close tab · Ctrl+Tab Next tab</span><span className="push">Gocode IDE · Free and local-first</span></footer>
  </div>;
}
