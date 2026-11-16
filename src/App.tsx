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
import { validateExtensionManifest } from "./lib/extensionManifest";
import { parseCommandLineArguments } from "./lib/commandLine";
import { normalizeDebugResponse, normalizeDebugScopes, normalizeDebugStackFrames, normalizeDebugThreads, normalizeDebugVariables } from "./lib/debugProtocol";
import { createDapCancelRequest } from "./lib/dapCancellation";
import { transitionDapLifecycle, type DapLifecycleEvent, type DapLifecycleState } from "./lib/dapLifecycle";
import { upsertDebugLaunchProfile, validateDebugLaunchProfile, type DebugLaunchProfile } from "./lib/debugLaunchProfiles";
import { isProjectFileUri, normalizeLspDiagnostics } from "./lib/languageProtocol";
import { normalizeCompletionResult, normalizeDefinitionLocation, normalizeHoverResult, normalizeReferenceLocations, type LanguageFeatureItem, type ReferenceLocation } from "./lib/languageFeatures";
import { reviewCapabilities } from "./lib/capabilityReview";
import { createFeedbackIssueUrl, type FeedbackCategory } from "./lib/feedback";
import { parseGitHunks, type GitHunk } from "./lib/gitHunks";
import { clampEditorFontSize, filterQuickOpenNames, findWorkspaceMatches, formatTaskOutput, isValidRelativeFileName, isWithinTextImportLimit, MAX_WORKSPACE_BACKUP_BYTES, MAX_WORKSPACE_FILES, MAX_WORKSPACE_FILE_CHARS, mergeWorkspaceFiles, sanitizeWorkspaceFiles } from "./lib/workspace";
import { TaskEventBuffer, type TaskEvent } from "./lib/taskEventBuffer";
import { getLspRecoveryDelay, MAX_LSP_RECOVERY_ATTEMPTS } from "./lib/lspRecovery";
import { loadLspLaunchProfiles, upsertLspLaunchProfile, validateLspLaunchProfile, type LspLaunchProfile } from "./lib/lspLaunchProfiles";
import { createWorkspaceRecoverySnapshot, parseWorkspaceRecoverySnapshot, type WorkspaceRecoverySnapshot } from "./lib/workspaceRecovery";
import { getVirtualWindow } from "./lib/virtualList";

type Panel = "Explorer" | "Search" | "Source Control" | "Run & Debug" | "Extensions" | "Settings";
type Workspace = Record<string, string>;
type ProjectEntry = { path: string; is_dir: boolean; size: number };
type ProjectTextFormat = { bom: boolean; line_ending: "lf" | "cr_lf" | "cr" };
type ProjectFileRead = { content: string; format: ProjectTextFormat };
type ProjectSearchResult = { path: string; line_number: number; snippet: string };
type GitResult = { available: boolean; output: string; branch: string; dirty: boolean };
type TaskResult = { command: string; success: boolean; output: string; timed_out?: boolean; cancelled?: boolean };
type ExtensionManifest = { id: string; name: string; version: string; publisher: string; license: string; description: string; capabilities: string[] };
type EditorDiagnostic = { message: string; lineNumber: number; column: number; severity: number };

function isProjectEntryVisible(entry: ProjectEntry, collapsedDirs: Record<string, boolean>): boolean {
  const parts = entry.path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    if (collapsedDirs[parts.slice(0, index).join("/")]) return false;
  }
  return true;
}
const STORAGE_KEY = "gocode-ide-workspace-v1";
const PROJECT_ROOT_KEY = "gocode-ide-last-project-root-v1";
const EXTENSIONS_KEY = "gocode-ide-extension-manifests-v1";
const EDITOR_SETTINGS_KEY = "gocode-ide-editor-settings-v1";
const RECOVERY_STORAGE_KEY = "gocode-ide-project-recovery-v1";
const LSP_LAUNCH_PROFILES_KEY = "gocode-ide-lsp-launch-profiles-v1";
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
  const [recoverySnapshot, setRecoverySnapshot] = useState<WorkspaceRecoverySnapshot | null>(() => {
    try { return parseWorkspaceRecoverySnapshot(localStorage.getItem(RECOVERY_STORAGE_KEY)); }
    catch { return null; }
  });
  const [recoveryCheckComplete, setRecoveryCheckComplete] = useState(() => {
    try { return parseWorkspaceRecoverySnapshot(localStorage.getItem(RECOVERY_STORAGE_KEY)) === null; }
    catch { return true; }
  });
  const recoveryCheckStarted = useRef(false);
  const [nativePaths, setNativePaths] = useState<Record<string, string>>({});
  const [savedProjectContents, setSavedProjectContents] = useState<Record<string, string>>({});
  const [projectFileFormats, setProjectFileFormats] = useState<Record<string, ProjectTextFormat>>({});
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [projectTreeScrollTop, setProjectTreeScrollTop] = useState(0);
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
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const taskAcceptEventsRef = useRef(false);
  const taskEventBufferRef = useRef(new TaskEventBuffer());
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
  const breakpointDecorationIds = useRef<string[]>([]);
  const [pendingCursor, setPendingCursor] = useState<{ path: string; line: number } | null>(null);
  const [message, setMessage] = useState("Ready");
  const [editorDiagnostics, setEditorDiagnostics] = useState<EditorDiagnostic[]>([]);
  const [lspDiagnosticsByUri, setLspDiagnosticsByUri] = useState<Record<string, EditorDiagnostic[]>>({});
  const [lspSessionId, setLspSessionId] = useState<string | null>(null);
  const lspSessionIdRef = useRef<string | null>(null);
  lspSessionIdRef.current = lspSessionId;
  const lspInitializationFailed = useRef<string | null>(null);
  const [lspReady, setLspReady] = useState(false);
  const [lspOutput, setLspOutput] = useState<string[]>([]);
  const [lspHoverText, setLspHoverText] = useState("");
  const [lspCompletions, setLspCompletions] = useState<LanguageFeatureItem[]>([]);
  const [lspReferences, setLspReferences] = useState<ReferenceLocation[]>([]);
  const lspRequestSeq = useRef(2);
  const lspRequestKinds = useRef<Record<number, string>>({});
  const lspLatestRequests = useRef<Record<string, number>>({});
  const lspRequestTimers = useRef<Record<number, number>>({});
  const lspLaunchConfig = useRef<{ executable: string; args: string[] } | null>(null);
  const [lspLaunchProfiles, setLspLaunchProfiles] = useState<LspLaunchProfile[]>(() => {
    try { return loadLspLaunchProfiles(localStorage.getItem(LSP_LAUNCH_PROFILES_KEY)); }
    catch { return []; }
  });
  const [selectedLspProfile, setSelectedLspProfile] = useState("");

  const lspInitializeHandled = useRef<string | null>(null);
  const lspRetryAttempt = useRef(0);
  const lspRetryTimer = useRef<number | null>(null);
  const lspRecoveryGeneration = useRef(0);
  const lspRecoveryEnabled = useRef(false);
  const [dapSessionId, setDapSessionId] = useState<string | null>(null);
  const dapSessionIdRef = useRef<string | null>(null);
  const [dapLifecycle, setDapLifecycle] = useState<DapLifecycleState>("idle");
  const dapLifecycleRef = useRef<DapLifecycleState>("idle");

  const [dapLaunchProfiles, setDapLaunchProfiles] = useState<DebugLaunchProfile[]>([]);
  const [selectedDapProfile, setSelectedDapProfile] = useState("");
  const [dapOutput, setDapOutput] = useState<string[]>([]);
  const [dapThreadId, setDapThreadId] = useState(1);
  const [dapFrameId, setDapFrameId] = useState(0);
  const [dapVariablesReference, setDapVariablesReference] = useState(1);
  const [dapThreads, setDapThreads] = useState<ReturnType<typeof normalizeDebugThreads>>([]);
  const [dapFrames, setDapFrames] = useState<ReturnType<typeof normalizeDebugStackFrames>>([]);
  const [dapScopes, setDapScopes] = useState<ReturnType<typeof normalizeDebugScopes>>([]);
  const [dapVariables, setDapVariables] = useState<ReturnType<typeof normalizeDebugVariables>>([]);
  const [dapWatchExpressions, setDapWatchExpressions] = useState<string[]>([]);
  const [dapWatchValues, setDapWatchValues] = useState<Record<string, string>>({});
  const [dapWatchDraft, setDapWatchDraft] = useState("");
  const [dapBreakpoints, setDapBreakpoints] = useState<Record<string, number[]>>({});
  const dapSeq = useRef(2);
  const dapRequestTimers = useRef<Record<number, number>>({});
  const dapRequestKinds = useRef<Record<number, string>>({});
  const dapWatchPending = useRef<Record<number, string>>({});
  const dapLaunchConfig = useRef<Record<string, unknown>>({});
  const dapLaunchRequest = useRef<"launch" | "attach">("launch");
  const [bottomPanel, setBottomPanel] = useState<"problems" | "terminal">("terminal");
  const [searchTerm, setSearchTerm] = useState("");
  const [projectSearchResults, setProjectSearchResults] = useState<ProjectSearchResult[]>([]);
  const [projectSearchBusy, setProjectSearchBusy] = useState(false);
  const projectSearchRequest = useRef(0);
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
  const visibleProjectEntries = useMemo(() => projectEntries.filter(entry => isProjectEntryVisible(entry, collapsedProjectDirs)), [projectEntries, collapsedProjectDirs]);
  const projectTreeWindow = useMemo(() => getVirtualWindow(visibleProjectEntries, projectTreeScrollTop, 480), [visibleProjectEntries, projectTreeScrollTop]);

  function projectFileUri(root: string, relative: string): string {
    const absolute = (root.replace(/\\/g, "/").replace(/\/$/, "") + "/" + relative.replace(/\\/g, "/"));
    return "file:///" + absolute.split("/").filter(Boolean).map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");
  }

  function clearLspRecovery(resetAttempts = false) {
    lspRecoveryGeneration.current += 1;
    if (lspRetryTimer.current !== null) window.clearTimeout(lspRetryTimer.current);
    lspRetryTimer.current = null;
    if (resetAttempts) lspRetryAttempt.current = 0;
  }

  function scheduleLspRecovery() {
    const config = lspLaunchConfig.current;
    if (!lspRecoveryEnabled.current || !config || !projectRoot || !isTauri()) return;
    const nextAttempt = lspRetryAttempt.current + 1;
    const delay = getLspRecoveryDelay(nextAttempt);
    if (delay === null) {
      setMessage(`Language server stopped after ${MAX_LSP_RECOVERY_ATTEMPTS} automatic recovery attempts. Use Restart Language Server to try again.`);
      return;
    }
    if (lspRetryTimer.current !== null) window.clearTimeout(lspRetryTimer.current);
    lspRetryAttempt.current = nextAttempt;
    const generation = lspRecoveryGeneration.current;
    setMessage(`Language server exited; retry ${nextAttempt}/${MAX_LSP_RECOVERY_ATTEMPTS} in ${delay / 1000}s.`);
    lspRetryTimer.current = window.setTimeout(async () => {
      lspRetryTimer.current = null;
      if (generation !== lspRecoveryGeneration.current) return;
      try {
        const rootUri = projectFileUri(projectRoot, "").replace(/\/$/, "");
        const id = await invoke<string>("lsp_start", {
          executable: config.executable,
          args: [...config.args],
          rootUri,
        });
        if (generation !== lspRecoveryGeneration.current) {
          await invoke("lsp_stop", { sessionId: id }).catch(() => undefined);
          return;
        }
        setLspSessionId(id);
        setLspReady(false);
        setMessage(`Language server recovery attempt ${nextAttempt} started; waiting for initialization.`);
      } catch (error) {
        if (generation === lspRecoveryGeneration.current) {
          setMessage("Automatic language-server recovery failed: " + String(error));
          scheduleLspRecovery();
        }
      }
    }, delay);
  }

  async function failLspInitialization(sessionId: string, detail: string) {
    if (lspInitializationFailed.current === sessionId) return;
    lspInitializationFailed.current = sessionId;
    setLspReady(false);
    for (const timer of Object.values(lspRequestTimers.current)) window.clearTimeout(timer);
    lspRequestTimers.current = {};
    lspRequestKinds.current = {};
    lspLatestRequests.current = {};
    lspOpenedDocuments.current.clear();
    setMessage("Language-server initialization failed: " + detail);
    try {
      // Stop the failed process; its exit event schedules the bounded retry.
      await invoke("lsp_stop", { sessionId });
    } catch (error) {
      setMessage("Language-server initialization failed and its process could not be stopped: " + String(error));
      if (lspRecoveryEnabled.current) scheduleLspRecovery();
    }
  }

  async function startLanguageServer(savedProfile?: LspLaunchProfile) {
    clearLspRecovery(true);
    lspRecoveryEnabled.current = true;
    if (!isTauri()) { setMessage("Language servers are available only in the installed desktop app."); return; }
    if (!projectRoot) { setMessage("Open a native project folder before starting a language server."); return; }

    let executable = "";
    let args: string[] = [];
    let profileToSave: LspLaunchProfile | null = null;
    let profileWarning = "";
    if (savedProfile) {
      try {
        profileToSave = validateLspLaunchProfile(savedProfile);
        executable = profileToSave.executable;
        args = [...profileToSave.args];
        setSelectedLspProfile(profileToSave.name);
      } catch (error) {
        setMessage("Saved language-server profile is invalid: " + String(error));
        return;
      }
    } else {
      const enteredExecutable = window.prompt("Enter the full path to a language-server executable you installed and trust:");
      if (!enteredExecutable?.trim()) return;
      executable = enteredExecutable.trim();
      const rawArgs = window.prompt("Optional executable arguments, separated by spaces (leave blank for none):", "") ?? "";
      try { args = parseCommandLineArguments(rawArgs); }
      catch (error) { setMessage("Invalid executable arguments: " + String(error)); return; }

      const profileName = window.prompt("Optional name to save this trusted language-server profile on this device (leave blank to use once):", "");
      if (profileName?.trim()) {
        try {
          profileToSave = validateLspLaunchProfile({ name: profileName.trim(), executable, args });
        } catch (error) {
          profileWarning = String(error);
        }
      }
    }

    try {
      if (lspSessionId) await invoke("lsp_stop", { sessionId: lspSessionId });
      for (const timer of Object.values(lspRequestTimers.current)) window.clearTimeout(timer);
      lspRequestTimers.current = {};
      lspRequestKinds.current = {};
      lspLatestRequests.current = {};
      setLspSessionId(null);
      setLspReady(false);
      setLspHoverText("");
      setLspCompletions([]);
      setLspReferences([]);
      setLspOutput([]);
      setLspDiagnosticsByUri({});
      setEditorDiagnostics([]);
      const rootUri = projectFileUri(projectRoot, "").replace(/\/$/, "");
      lspOpenedDocuments.current.clear();
      lspDocumentVersion.current = 1;
      lspLaunchConfig.current = { executable, args: [...args] };
      const id = await invoke<string>("lsp_start", { executable, args, rootUri });
      setLspSessionId(id);
      setLspReady(false);
      if (profileToSave) {
        try {
          const nextProfiles = upsertLspLaunchProfile(lspLaunchProfiles, profileToSave);
          localStorage.setItem(LSP_LAUNCH_PROFILES_KEY, JSON.stringify(nextProfiles));
          setLspLaunchProfiles(nextProfiles);
          setSelectedLspProfile(profileToSave.name);
        } catch (error) {
          setMessage("Language server started, but its profile could not be saved: " + String(error));
          return;
        }
      }
      setMessage(profileWarning
        ? "Language server started for this session; profile was not saved: " + profileWarning
        : "Language server started; waiting for initialization.");
    } catch (error) { setMessage("Could not start language server: " + String(error)); }
  }


  function applyDapLifecycleEvent(event: DapLifecycleEvent) {
    const transition = transitionDapLifecycle(dapLifecycleRef.current, event);
    if (!transition.accepted) {
      setDapOutput(current => [...current, `Ignored out-of-order DAP lifecycle event: ${dapLifecycleRef.current} → ${event}.`].slice(-100));
      return;
    }
    dapLifecycleRef.current = transition.state;
    setDapLifecycle(transition.state);
  }

  async function sendDapRequest(command: string, args: Record<string, unknown> = {}) {
    if (!dapSessionId) return;
    const seq = dapSeq.current++;
    dapRequestKinds.current[seq] = command;
    if (command === "evaluate" && typeof args.expression === "string") dapWatchPending.current[seq] = args.expression;
    dapRequestTimers.current[seq] = window.setTimeout(() => {
      const timedOutCommand = dapRequestKinds.current[seq];
      delete dapRequestKinds.current[seq];
      delete dapRequestTimers.current[seq];
      const watchExpression = dapWatchPending.current[seq];
      delete dapWatchPending.current[seq];
      if (watchExpression) setDapWatchValues(current => ({ ...current, [watchExpression]: "Evaluation timed out" }));
      if (["launch", "attach", "configurationDone"].includes(command)) applyDapLifecycleEvent("failure");
      setMessage("Debug-adapter request timed out: " + command);

      // DAP cancellation is best-effort: adapters may not support it, but a
      // supported adapter can stop expensive requests after the UI times out.
      if (timedOutCommand && timedOutCommand !== "cancel" && dapSessionId) {
        const cancelSeq = dapSeq.current++;
        const cancelRequest = createDapCancelRequest(cancelSeq, seq);
        if (cancelRequest) {
          dapRequestKinds.current[cancelSeq] = "cancel";
          dapRequestTimers.current[cancelSeq] = window.setTimeout(() => {
            delete dapRequestKinds.current[cancelSeq];
            delete dapRequestTimers.current[cancelSeq];
          }, 5000);
          void invoke("dap_send", { sessionId: dapSessionId, message: cancelRequest })
            .then(() => setDapOutput(current => [...current, `→ cancel (#${cancelSeq}) for ${timedOutCommand} (#${seq})`].slice(-100)))
            .catch(error => {
              window.clearTimeout(dapRequestTimers.current[cancelSeq]);
              delete dapRequestTimers.current[cancelSeq];
              delete dapRequestKinds.current[cancelSeq];
              setDapOutput(current => [...current, `DAP cancellation request could not be sent: ${String(error)}`].slice(-100));
            });
        }
      }
    }, 15000);
    try {
      await invoke("dap_send", { sessionId: dapSessionId, message: { seq, type: "request", command, arguments: args } });
      setDapOutput(current => [...current, `→ ${command} (#${seq})`].slice(-100));
    } catch (error) {
      window.clearTimeout(dapRequestTimers.current[seq]);
      delete dapRequestTimers.current[seq];
      delete dapRequestKinds.current[seq];
      const watchExpression = dapWatchPending.current[seq];
      delete dapWatchPending.current[seq];
      if (watchExpression) setDapWatchValues(current => ({ ...current, [watchExpression]: "Evaluation request failed" }));
      setMessage("DAP request failed: " + String(error));
    }
  }

  async function toggleBreakpointAtLine(line: number) {
    if (!dapSessionId || !projectRoot || !Number.isInteger(line) || line < 1) return;
    const lines = dapBreakpoints[fileName] ?? [];
    const next = lines.includes(line) ? lines.filter(value => value !== line) : [...lines, line].sort((a, b) => a - b);
    setDapBreakpoints(current => ({ ...current, [fileName]: next }));
    const sourcePath = projectRoot.replace(/[\\/]+$/, "") + "/" + fileName.replace(/\\/g, "/");
    await sendDapRequest("setBreakpoints", {
      source: { name: fileName.split("/").pop() ?? fileName, path: sourcePath },
      breakpoints: next.map(lineNumber => ({ line: lineNumber })),
      sourceModified: false
    });
    setMessage((next.includes(line) ? "Added" : "Removed") + " breakpoint at " + fileName + ":" + line + ".");
  }

  async function toggleBreakpointAtCursor() {
    await toggleBreakpointAtLine(cursorPosition.line);
  }

  async function startDebugAdapter(savedProfile?: DebugLaunchProfile) {
    if (!isTauri()) { setMessage("Debug adapters are available only in the installed desktop app."); return; }
    let profile: DebugLaunchProfile;
    try {
      if (savedProfile) {
        profile = validateDebugLaunchProfile(savedProfile);
      } else {
        const executable = window.prompt("Enter the full path to a debug-adapter executable you installed and trust:");
        if (!executable?.trim()) return;
        const rawArgs = window.prompt("Optional executable arguments (supports quoted arguments; leave blank for none):", "") ?? "";
        const adapterArgs = parseCommandLineArguments(rawArgs);
        const requestText = window.prompt('Debug request: enter "launch" or "attach".', "launch");
        if (requestText !== "launch" && requestText !== "attach") throw new Error("Debug request must be launch or attach.");
        const configText = window.prompt('Enter adapter-specific configuration as JSON (for example, {"program":"C:/path/to/app.js"}):');
        if (!configText?.trim()) return;
        const parsed: unknown = JSON.parse(configText);
        const draft = validateDebugLaunchProfile({
          name: "Current session",
          executable: executable.trim(),
          adapterArgs,
          request: requestText,
          configuration: parsed,
        });
        const profileName = window.prompt("Optional name to save this configuration for this app session (leave blank to use once):", "");
        profile = profileName?.trim()
          ? validateDebugLaunchProfile({ ...draft, name: profileName.trim() })
          : draft;
        if (profileName?.trim()) {
          setDapLaunchProfiles(current => upsertDebugLaunchProfile(current, profile));
          setSelectedDapProfile(profile.name);
        }
      }
    } catch (error) {
      setMessage("Invalid debug launch configuration: " + String(error));
      return;
    }
    try {
      if (dapSessionId) {
        applyDapLifecycleEvent("stopRequested");
        await invoke("dap_stop", { sessionId: dapSessionId });
        dapSessionIdRef.current = null;
        setDapSessionId(null);
        applyDapLifecycleEvent("terminated");
      } else if (dapLifecycleRef.current !== "idle" && dapLifecycleRef.current !== "terminated" && dapLifecycleRef.current !== "failed") {
        applyDapLifecycleEvent("reset");
      }
      applyDapLifecycleEvent("start");
      dapLaunchConfig.current = profile.configuration;
      dapLaunchRequest.current = profile.request;
      dapSeq.current = 2;
      for (const timer of Object.values(dapRequestTimers.current)) window.clearTimeout(timer);
      dapRequestTimers.current = {};
      dapRequestKinds.current = {};
      dapWatchPending.current = {};
      setDapWatchValues({});
      setDapOutput([]);
      setDapThreads([]);
      setDapFrames([]);
      setDapScopes([]);
      setDapVariables([]);
      setDapBreakpoints({});
      const id = await invoke<string>("dap_start", { executable: profile.executable, args: profile.adapterArgs });
      dapSessionIdRef.current = id;
      setDapSessionId(id);
      applyDapLifecycleEvent("processStarted");
      setMessage("Debug adapter started; initializing " + profile.request + ".");
    } catch (error) {
      applyDapLifecycleEvent("failure");
      setMessage("Could not start debug adapter: " + String(error));
    }
  }

  function addWatchExpression(event: FormEvent) {
    event.preventDefault();
    const expression = dapWatchDraft.trim();
    if (!expression || expression.length > 500 || !dapSessionId) return;
    setDapWatchExpressions(current => current.includes(expression) ? current : [...current, expression].slice(-50));
    setDapWatchDraft("");
    void sendDapRequest("evaluate", { expression, frameId: dapFrameId, context: "watch" });
  }

  function refreshWatchExpressions() {
    if (!dapSessionId) return;
    for (const expression of dapWatchExpressions) {
      void sendDapRequest("evaluate", { expression, frameId: dapFrameId, context: "watch" });
    }
  }

  async function stopDebugAdapter() {
    if (!dapSessionId) return;
    applyDapLifecycleEvent("stopRequested");
    try {
      await invoke("dap_stop", { sessionId: dapSessionId });
      applyDapLifecycleEvent("terminated");
    } catch (error) {
      applyDapLifecycleEvent("failure");
      setMessage("Debug-adapter stop failed; the session handle was retained so cleanup can be retried: " + String(error));
      return;
    }
    dapSessionIdRef.current = null;
    setDapSessionId(null);
    setDapThreads([]);
    setDapFrames([]);
    setDapScopes([]);
    setDapVariables([]);
    setDapBreakpoints({});
    for (const timer of Object.values(dapRequestTimers.current)) window.clearTimeout(timer);
    dapRequestTimers.current = {};
    dapRequestKinds.current = {};
    dapWatchPending.current = {};
    setDapWatchValues({});
    setMessage("Debug adapter stopped.");
  }

  useEffect(() => {
    if (!isTauri() || !dapSessionId) return;
    let active = true;
    let unlistenMessage: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    void Promise.all([
      listen<{ session_id: string; message: Record<string, unknown> }>("dap-message", async event => {
        if (!active || event.payload.session_id !== dapSessionIdRef.current) return;
        const message = event.payload.message;
        const kind = String(message.type ?? "message");
        const label = message.event ? String(message.event) : message.command ? String(message.command) : kind;
        if (kind === "response") {
          const response = normalizeDebugResponse(message);
          if (!response) {
            setMessage("Debug adapter sent a malformed response; it was ignored.");
            return;
          }
          const expectedCommand = dapRequestKinds.current[response.requestSeq];
          if (!expectedCommand) {
            setDapOutput(current => [...current, `Ignored unmatched DAP response #${response.requestSeq} (${response.command}).`].slice(-100));
            return;
          }
          window.clearTimeout(dapRequestTimers.current[response.requestSeq]);
          delete dapRequestTimers.current[response.requestSeq];
          delete dapRequestKinds.current[response.requestSeq];
          const watchExpression = dapWatchPending.current[response.requestSeq];
          delete dapWatchPending.current[response.requestSeq];
          if (response.command !== expectedCommand) {
            setMessage(`DAP response mismatch: expected ${expectedCommand}, received ${response.command}.`);
            return;
          }
          if (watchExpression) setDapWatchValues(current => ({ ...current, [watchExpression]: message.success === true ? String((message.body as { result?: unknown; type?: unknown } | undefined)?.result ?? "(no result)") + (((message.body as { type?: unknown } | undefined)?.type) ? " [" + String((message.body as { type?: unknown }).type) + "]" : "") : "Evaluation failed" }));
        }
        setDapOutput(current => [...current, `← ${label}: ${JSON.stringify(message).slice(0, 700)}`].slice(-100));
        if (kind === "response" && message.success === false) {
          const responseMessage = typeof message.message === "string" ? message.message : "The adapter rejected the request.";
          if (["initialize", "launch", "attach", "configurationDone"].includes(String(message.command))) applyDapLifecycleEvent("failure");
          setMessage("DAP " + String(message.command ?? "request") + " failed: " + responseMessage);
        }
        if (kind === "response" && message.success === true) {
          if (message.command === "initialize") applyDapLifecycleEvent("initializeSucceeded");
          if (message.command === "configurationDone") applyDapLifecycleEvent("configurationDone");
          if (message.command === "threads") setDapThreads(normalizeDebugThreads(message));
          if (message.command === "stackTrace") {
            const frames = normalizeDebugStackFrames(message);
            setDapFrames(frames);
            if (frames.length) setDapFrameId(frames[0].id);
          }
          if (message.command === "scopes") {
            const scopes = normalizeDebugScopes(message);
            setDapScopes(scopes);
            if (scopes.length) setDapVariablesReference(scopes[0].variablesReference);
          }
          if (message.command === "variables") setDapVariables(normalizeDebugVariables(message));
        }
        if (kind === "event" && message.event === "stopped") {
          applyDapLifecycleEvent("stopped");
          const body = message.body as { threadId?: number; reason?: string; allThreadsStopped?: boolean } | undefined;
          const stoppedThread = Number.isInteger(body?.threadId) ? body!.threadId! : dapThreadId;
          setDapThreadId(stoppedThread);
          setMessage("Debugger stopped" + (body?.reason ? " (" + body.reason + ")" : "") + ".");
          void sendDapRequest("threads");
          void sendDapRequest("stackTrace", { threadId: stoppedThread });
        }
        if (kind === "event" && message.event === "continued") {
          applyDapLifecycleEvent("continued");
          setDapFrames([]);
          setDapScopes([]);
          setDapVariables([]);
          setMessage("Debuggee continued.");
        }
        if (kind === "event" && message.event === "thread") {
          void sendDapRequest("threads");
        }
        if (kind === "event" && message.event === "output") {
          const body = message.body as { category?: string; output?: string } | undefined;
          if (typeof body?.output === "string" && body.output.length) {
            setDapOutput(current => [...current, (body.category ? "[" + body.category + "] " : "") + body.output!.slice(0, 4000)].slice(-100));
          }
        }
        if (kind === "event" && message.event === "breakpoint") {
          setMessage("Debugger breakpoint state changed.");
        }
        if (kind === "event" && (message.event === "terminated" || message.event === "exited")) {
          applyDapLifecycleEvent("terminated");
          setDapFrames([]);
          setDapScopes([]);
          setDapVariables([]);
          setMessage(message.event === "terminated" ? "Debug session terminated." : "Debuggee exited.");
        }
        if (kind === "response" && message.command === "initialize" && message.success === true) {
          await sendDapRequest(dapLaunchRequest.current, dapLaunchConfig.current);
        }
        if (kind === "event" && message.event === "initialized") {
          applyDapLifecycleEvent("initialized");
          await sendDapRequest("configurationDone");
        }
      }),
      listen<{ session_id: string; message: string }>("dap-error", event => {
        if (active && event.payload.session_id === dapSessionIdRef.current) {
          applyDapLifecycleEvent("failure");
          setMessage("Debug-adapter error: " + event.payload.message);
        }
      }),
      listen<{ session_id: string }>("dap-exited", event => {
        if (active && event.payload.session_id === dapSessionIdRef.current) {
          applyDapLifecycleEvent("processExited");
          dapSessionIdRef.current = null;
          setDapSessionId(null);
          setDapThreads([]);
          setDapFrames([]);
          setDapScopes([]);
          setDapVariables([]);
          for (const timer of Object.values(dapRequestTimers.current)) window.clearTimeout(timer);
          dapRequestTimers.current = {};
          dapRequestKinds.current = {};
          dapWatchPending.current = {};
          setDapWatchValues({});
          setMessage("Debug adapter exited.");
        }
      })
    ]).then(([message, error, exited]) => {
      if (!active) { message(); error(); exited(); return; }
      unlistenMessage = message; unlistenError = error; unlistenExit = exited;
      // Subscribe before sending initialize; some adapters respond immediately.
      dapRequestKinds.current[1] = "initialize";
      dapRequestTimers.current[1] = window.setTimeout(() => {
        delete dapRequestKinds.current[1];
        delete dapRequestTimers.current[1];
        applyDapLifecycleEvent("failure");
        setMessage("Debug-adapter request timed out: initialize");
      }, 15000);
      void invoke("dap_send", { sessionId: dapSessionId, message: {
        seq: 1, type: "request", command: "initialize",
        arguments: {
          clientID: "gocode-ide", clientName: "Gocode IDE", adapterID: "user-configured",
          locale: "en", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path",
          supportsVariableType: true, supportsRunInTerminalRequest: false, supportsProgressReporting: true
        }
      }}).catch(error => {
        window.clearTimeout(dapRequestTimers.current[1]);
        delete dapRequestTimers.current[1];
        delete dapRequestKinds.current[1];
        setMessage("Could not initialize debug adapter: " + String(error));
      });
    });
    return () => {
      active = false;
      unlistenMessage?.(); unlistenError?.(); unlistenExit?.();
      for (const timer of Object.values(dapRequestTimers.current)) window.clearTimeout(timer);
      dapRequestTimers.current = {};
      dapRequestKinds.current = {};
      dapWatchPending.current = {};
    };
  }, [dapSessionId]);

  function applyLspCompletion(item: LanguageFeatureItem) {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) {
      setMessage("Open an editor document before applying a completion.");
      return;
    }
    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: position.column,
    };
    editor.executeEdits("gocode-lsp-completion", [{ range, text: item.insertText || item.label, forceMoveMarkers: true }]);
    editor.focus();
    setLspCompletions([]);
    setMessage("Inserted completion: " + item.label);
  }

  async function sendLspRequest(method: string, params: Record<string, unknown>) {
    if (!lspSessionId || !lspReady || !projectRoot) return;
    const id = lspRequestSeq.current++;
    if (method === "textDocument/hover" || method === "textDocument/completion") {
      const previousId = lspLatestRequests.current[method];
      if (previousId !== undefined) {
        window.clearTimeout(lspRequestTimers.current[previousId]);
        delete lspRequestTimers.current[previousId];
        delete lspRequestKinds.current[previousId];
        void invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: previousId } } }).catch(() => undefined);
      }
      lspLatestRequests.current[method] = id;
    }
    lspRequestKinds.current[id] = method;
    lspRequestTimers.current[id] = window.setTimeout(() => {
      delete lspRequestKinds.current[id];
      delete lspRequestTimers.current[id];
      if (lspLatestRequests.current[method] === id) delete lspLatestRequests.current[method];
      // JSON-RPC cancellation is advisory, but it lets capable language servers
      // stop expensive work after the editor has abandoned a timed-out request.
      void invoke("lsp_send", {
        sessionId: lspSessionId,
        message: { jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }
      }).catch(() => undefined);
      setMessage("Language-server request timed out: " + method);
    }, 15000);
    if (method === "textDocument/hover") setLspHoverText("");
    if (method === "textDocument/completion") setLspCompletions([]);
    try {
      await invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", id, method, params } });
      setLspOutput(current => [...current, "→ " + method + " (#" + id + ")"].slice(-40));
    } catch (error) {
      window.clearTimeout(lspRequestTimers.current[id]);
      delete lspRequestTimers.current[id];
      delete lspRequestKinds.current[id];
      if (lspLatestRequests.current[method] === id) delete lspLatestRequests.current[method];
      setMessage("Language-server request failed: " + String(error));
    }
  }

  async function notifyLspDocumentSaved(name: string) {
    if (!lspReady || !lspSessionId || !projectRoot) return;
    const uri = projectFileUri(projectRoot, name);
    if (!lspOpenedDocuments.current.has(uri)) return;
    try {
      await invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "textDocument/didSave", params: { textDocument: { uri }, text: name === fileName ? text : files[name] ?? "" } } });
    } catch (error) {
      setMessage("File saved, but language-server save notification failed: " + String(error));
    }
  }

  async function stopLanguageServer() {
    clearLspRecovery(true);
    lspRecoveryEnabled.current = false;
    if (!lspSessionId) return;
    try { await invoke("lsp_stop", { sessionId: lspSessionId }); }
    catch (error) { setMessage("Language-server stop failed: " + String(error)); }
    setLspSessionId(null);
    setLspReady(false);
    for (const timer of Object.values(lspRequestTimers.current)) window.clearTimeout(timer);
    lspRequestTimers.current = {};
    lspRequestKinds.current = {};
    lspLatestRequests.current = {};
    lspOpenedDocuments.current.clear();
    lspDocumentVersion.current = 1;
    setEditorDiagnostics([]);
    setLspDiagnosticsByUri({});
    setMessage("Language server stopped.");
  }

  async function restartLanguageServer() {
    clearLspRecovery(true);
    lspRecoveryEnabled.current = true;
    const config = lspLaunchConfig.current;
    if (!config || !projectRoot || !isTauri()) {
      setMessage("Start a language server once before using restart.");
      return;
    }
    try {
      const previousSession = lspSessionId;
      if (previousSession) await invoke("lsp_stop", { sessionId: previousSession });
      for (const timer of Object.values(lspRequestTimers.current)) window.clearTimeout(timer);
      lspRequestTimers.current = {};
      lspRequestKinds.current = {};
      lspLatestRequests.current = {};
      lspOpenedDocuments.current.clear();
      lspDocumentVersion.current = 1;
      setLspSessionId(null);
      setLspReady(false);
      setLspHoverText("");
      setLspCompletions([]);
      setLspReferences([]);
      setLspDiagnosticsByUri({});
      setEditorDiagnostics([]);
      setLspOutput([]);
      const rootUri = projectFileUri(projectRoot, "").replace(/\/$/, "");
      const id = await invoke<string>("lsp_start", {
        executable: config.executable,
        args: [...config.args],
        rootUri,
      });
      setLspSessionId(id);
      setMessage("Language server restarted; waiting for initialization.");
    } catch (error) {
      setLspSessionId(null);
      setLspReady(false);
      setMessage("Could not restart language server: " + String(error));
    }
  }

  useEffect(() => () => {
    lspRecoveryEnabled.current = false;
    lspRecoveryGeneration.current += 1;
    if (lspRetryTimer.current !== null) window.clearTimeout(lspRetryTimer.current);
    lspRetryTimer.current = null;
    const activeSession = lspSessionIdRef.current;
    lspSessionIdRef.current = null;
    if (activeSession) void invoke("lsp_stop", { sessionId: activeSession }).catch(() => undefined);
    for (const timer of Object.values(lspRequestTimers.current)) window.clearTimeout(timer);
    lspRequestTimers.current = {};
    lspRequestKinds.current = {};
    lspLatestRequests.current = {};
    lspOpenedDocuments.current.clear();
  }, [projectRoot]);

  useEffect(() => {
    if (!projectRoot) { setEditorDiagnostics([]); return; }
    const uri = projectFileUri(projectRoot, fileName);
    setEditorDiagnostics(lspDiagnosticsByUri[uri] ?? []);
  }, [fileName, projectRoot, lspDiagnosticsByUri]);

  const lspDocumentVersion = useRef(1);
  const lspOpenedDocuments = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!lspReady || !lspSessionId || !projectRoot) return;
    const uri = projectFileUri(projectRoot, fileName);
    const version = ++lspDocumentVersion.current;
    const method = lspOpenedDocuments.current.has(uri) ? "textDocument/didChange" : "textDocument/didOpen";
    const params = method === "textDocument/didOpen"
      ? { textDocument: { uri, languageId: languageForFile(fileName), version, text } }
      : { textDocument: { uri, version }, contentChanges: [{ text }] };
    lspOpenedDocuments.current.add(uri);
    void invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method, params } })
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
        if (message.id === 1 && message.error) {
          const detail = String((message.error as { message?: string }).message ?? "Unknown initialize error");
          void failLspInitialization(lspSessionId, detail);
        }
        if (message.id === 1 && message.result && lspInitializeHandled.current !== lspSessionId) {
          lspInitializeHandled.current = lspSessionId;
          try {
            await invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "initialized", params: {} } });
            const doc = lspDocumentRef.current;
            if (doc.projectRoot) {
              const uri = projectFileUri(doc.projectRoot, doc.fileName);
              await invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: languageForFile(doc.fileName), version: 1, text: doc.text } } } });
              lspOpenedDocuments.current.add(uri);
              setLspReady(true);
              lspRetryAttempt.current = 0;
              setMessage("Language server initialized for " + doc.fileName + ".");
            }
          } catch (error) {
            lspInitializeHandled.current = null;
            setLspReady(false);
            setMessage("Language-server initialization failed: " + String(error));
          }
        }
        if (message.id !== undefined && message.id !== 1 && (message.result !== undefined || message.error !== undefined)) {
          setLspOutput(current => [...current, "← response #" + String(message.id) + ": " + JSON.stringify(message.result ?? message.error).slice(0, 900)].slice(-40));
          if (typeof message.id === "number" && Number.isFinite(message.id)) {
            window.clearTimeout(lspRequestTimers.current[message.id]);
            delete lspRequestTimers.current[message.id];
            const responseKind = lspRequestKinds.current[message.id];
            if (responseKind && lspLatestRequests.current[responseKind] === message.id) delete lspLatestRequests.current[responseKind];
          }
          if (message.error) {
            if (typeof message.id === "number") delete lspRequestKinds.current[message.id];
            setMessage("Language-server request failed: " + String((message.error as { message?: string }).message ?? "Unknown error"));
          } else if (message.method === undefined && (typeof message.id === "number" || typeof message.id === "string")) {
            const requestKind = lspRequestKinds.current[Number(message.id)];
            delete lspRequestKinds.current[Number(message.id)];
            const result = message.result;
            if (requestKind === "textDocument/hover") {
              setLspHoverText(normalizeHoverResult(result));
            } else if (requestKind === "textDocument/completion") {
              setLspCompletions(normalizeCompletionResult(result));
            } else if (requestKind === "textDocument/references" && projectRoot) {
              setLspReferences(normalizeReferenceLocations(result, projectRoot));
              setMessage("Language server returned " + normalizeReferenceLocations(result, projectRoot).length + " project-local reference(s).");
            } else if (requestKind === "textDocument/definition" && projectRoot) {
              const location = normalizeDefinitionLocation(result, projectRoot);
              if (location) {
                setPendingCursor({ path: location.path, line: location.line });
                setFileName(location.path);
                setMessage("Go to definition: " + location.path + ":" + location.line + ":" + location.column);
                window.setTimeout(() => {
                  editorRef.current?.setPosition({ lineNumber: location.line, column: location.column });
                  editorRef.current?.revealPositionInCenter({ lineNumber: location.line, column: location.column });
                }, 0);
              } else {
                setMessage("Language server returned no project-local definition location.");
              }
            }
          }
        }
        if (message.method === "textDocument/publishDiagnostics") {
          const params = message.params as { uri?: string; diagnostics?: unknown } | undefined;
          const doc = lspDocumentRef.current;
          const rootUri = doc.projectRoot ? projectFileUri(doc.projectRoot, "").replace(/\/$/, "") : "";
          if (params?.uri && isProjectFileUri(params.uri, rootUri)) {
            const markers = normalizeLspDiagnostics(params.diagnostics).map(item => ({
              message: item.message,
              lineNumber: item.lineNumber,
              column: item.column,
              severity: item.severity === "error" ? 8 : item.severity === "warning" ? 4 : item.severity === "hint" ? 1 : 2,
            }));
            setLspDiagnosticsByUri(current => {
              const next = { ...current, [params.uri!]: markers };
              const staleUris = Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - 200));
              for (const staleUri of staleUris) delete next[staleUri];
              return next;
            });
            if (doc.projectRoot && params.uri === projectFileUri(doc.projectRoot, doc.fileName)) {
              setEditorDiagnostics(markers);
            }
          }
        }
      }),
      listen<{ session_id: string; message: string }>("lsp-error", event => {
        if (active && event.payload.session_id === lspSessionId) setMessage("Language-server error: " + event.payload.message);
      }),
      listen<{ session_id: string }>("lsp-exited", event => {
        if (active && event.payload.session_id === lspSessionId) {
          setLspReady(false);
          for (const timer of Object.values(lspRequestTimers.current)) window.clearTimeout(timer);
          lspRequestTimers.current = {};
          lspRequestKinds.current = {};
          lspLatestRequests.current = {};
          setLspSessionId(null);
          lspOpenedDocuments.current.clear();
          setMessage("Language server exited.");
          if (lspRecoveryEnabled.current) scheduleLspRecovery();
        }
      })
    ]).then(([message, error, exited]) => {
      if (!active) { message(); error(); exited(); return; }
      unlistenMessage = message; unlistenError = error; unlistenExit = exited;
      // Subscribe before initialize to avoid losing a fast server's response.
      if (lspSessionId && projectRoot) {
        const rootUri = projectFileUri(projectRoot, "").replace(/\/$/, "");
        void invoke("lsp_send", { sessionId: lspSessionId, message: {
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: {
            processId: null, rootUri,
            capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true }, synchronization: { didSave: true } } },
            clientInfo: { name: "Gocode IDE", version: "0.1.0" }
          }
        }}).catch(error => { void failLspInitialization(lspSessionId, String(error)); });
      }
    });
    return () => { active = false; unlistenMessage?.(); unlistenError?.(); unlistenExit?.(); };
  }, [lspSessionId, projectRoot]);

  useEffect(() => {
    setOpenTabs(current => current.includes(fileName) ? current : [...current, fileName]);
  }, [fileName]);

  function isProjectTabDirty(name: string): boolean {
    return projectEntries.some(entry => entry.path === name && !entry.is_dir) && Object.prototype.hasOwnProperty.call(savedProjectContents, name) && (files[name] ?? "") !== savedProjectContents[name];
  }

  function closeEditorTab(name: string) {
    if (isProjectTabDirty(name) && !window.confirm("\u201c" + name + "\u201d has unsaved changes. Close this tab anyway?")) return;
    if (lspSessionId && lspReady && projectRoot) {
      const uri = projectFileUri(projectRoot, name);
      if (lspOpenedDocuments.current.has(uri)) {
        void invoke("lsp_send", { sessionId: lspSessionId, message: { jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } } })
          .catch(error => setMessage("Tab closed, but language-server close notification failed: " + String(error)));
        lspOpenedDocuments.current.delete(uri);
        setLspDiagnosticsByUri(current => {
          const next = { ...current };
          delete next[uri];
          return next;
        });
      }
    }
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
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const lines = (dapBreakpoints[fileName] ?? []).filter(line => line >= 1 && line <= model.getLineCount());
    breakpointDecorationIds.current = editor.deltaDecorations(
      breakpointDecorationIds.current,
      lines.map(line => ({
        range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
        options: { glyphMarginClassName: "gocode-breakpoint-glyph" }
      }))
    );
  }, [dapBreakpoints, fileName, text]);

  useEffect(() => {
    if (!pendingCursor || pendingCursor.path !== fileName || !editorRef.current) return;
    const line = Math.max(1, Math.min(pendingCursor.line, editorRef.current.getModel()?.getLineCount() ?? 1));
    editorRef.current.revealLineInCenter(line);
    editorRef.current.setPosition({ lineNumber: line, column: 1 });
    editorRef.current.focus();
    setPendingCursor(null);
  }, [pendingCursor, fileName, text]);
  const matches = useMemo(() => findWorkspaceMatches(files, searchTerm), [files, searchTerm]);
  const gitHunks = useMemo(() => parseGitHunks(gitDiff), [gitDiff]);

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
        const manifest: ExtensionManifest = validateExtensionManifest(JSON.parse(raw));
        setExtensions(old => old.some(x => x.id === manifest.id) ? old.map(x => x.id === manifest.id ? manifest : x) : [...old, manifest]);
        setExtensionError("Manifest added for review. Its code has NOT been installed or executed.");
      } catch (error) { setExtensionError("Invalid manifest: " + String(error)); }
    });
  }

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(files)); }
    catch { setMessage("Browser storage is full. Download your files for backup."); }
  }, [files]);

  // Persist only unsaved native project buffers locally. Never upload recovery data.
  useEffect(() => {
    if (!projectRoot || !isTauri() || !recoveryCheckComplete || recoverySnapshot) return;
    const dirtyFiles: Record<string, { content: string; baseline: string }> = {};
    for (const name of openTabs) {
      if (!projectEntries.some(entry => entry.path === name && !entry.is_dir)) continue;
      const content = files[name];
      const baseline = savedProjectContents[name];
      if (typeof content === "string" && typeof baseline === "string" && content !== baseline) {
        dirtyFiles[name] = { content, baseline };
      }
    }
    const snapshot = createWorkspaceRecoverySnapshot(projectRoot, dirtyFiles);
    try {
      if (snapshot) localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(snapshot));
      else if (Object.keys(dirtyFiles).length === 0) localStorage.removeItem(RECOVERY_STORAGE_KEY);
      else setMessage("Unsaved buffers exceed the recovery limit. Save project files manually; the previous snapshot was preserved.");
    } catch {
      setMessage("Could not save the local recovery snapshot. Save your project files manually.");
    }
  }, [files, openTabs, projectEntries, projectRoot, savedProjectContents, recoveryCheckComplete, recoverySnapshot]);

  // Recover only into the editor after checking current disk contents. The disk is never
  // overwritten automatically; a later explicit save still uses the verified disk baseline.
  useEffect(() => {
    if (!projectRoot || !isTauri() || !recoverySnapshot || recoveryCheckStarted.current) return;
    if (recoverySnapshot.projectRoot !== projectRoot) {
      setRecoveryCheckComplete(true);
      return;
    }
    recoveryCheckStarted.current = true;
    let cancelled = false;
    void (async () => {
      const candidates: Array<{ path: string; content: string; disk: string; format: ProjectTextFormat }> = [];
      const conflicts: string[] = [];
      const missing: string[] = [];
      for (const [path, item] of Object.entries(recoverySnapshot.files)) {
        if (cancelled) return;
        try {
          const diskFile = await invoke<ProjectFileRead>("read_project_file", { path });
          if (diskFile.content !== item.baseline) conflicts.push(path);
          candidates.push({ path, content: item.content, disk: diskFile.content, format: diskFile.format });
        } catch {
          missing.push(path);
        }
      }
      if (cancelled) return;
      if (candidates.length) {
        const details = [
          "Gocode IDE found " + candidates.length + " unsaved project buffer(s) from the previous session.",
          conflicts.length ? conflicts.length + " file(s) changed on disk since the recovery snapshot." : "",
          missing.length ? missing.length + " file(s) are no longer available and will be skipped." : "",
          "Restore the available buffers into the editor? Nothing will be written to disk automatically."
        ].filter(Boolean).join("\n");
        if (window.confirm(details)) {
          const recoveredFiles = Object.fromEntries(candidates.map(item => [item.path, item.content]));
          const currentBaselines = Object.fromEntries(candidates.map(item => [item.path, item.disk]));
          setFiles(current => ({ ...current, ...recoveredFiles }));
          setSavedProjectContents(current => ({ ...current, ...currentBaselines }));
          setProjectFileFormats(current => ({ ...current, ...Object.fromEntries(candidates.map(item => [item.path, item.format])) }));
          setOpenTabs(current => [...new Set([...current, ...candidates.map(item => item.path)])]);
          setFileName(candidates[0].path);
          setMessage("Recovered " + candidates.length + " unsaved buffer(s). Review changes before saving.");
        } else {
          setMessage("Previous-session recovery was dismissed.");
        }
      } else {
        setMessage("A recovery snapshot was found, but none of its files are currently available.");
      }
      try { localStorage.removeItem(RECOVERY_STORAGE_KEY); } catch { /* Recovery remains best-effort. */ }
      setRecoverySnapshot(null);
      setRecoveryCheckComplete(true);
    })();
    return () => { cancelled = true; };
  }, [projectRoot, recoverySnapshot]);

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
      const file = await invoke<ProjectFileRead>("read_project_file", { path });
      const contents = file.content;
      setFiles(current => ({ ...current, [path]: contents }));
      setSavedProjectContents(current => ({ ...current, [path]: contents }));
      setProjectFileFormats(current => ({ ...current, [path]: file.format }));
      setFileName(path);
      setPanel("Explorer");
      setMessage("Opened project file " + path);
    } catch (error) { setMessage("Open project file failed: " + String(error)); }
  }
  async function saveProjectFile() {
    try {
      await invoke("write_project_file", { path: fileName, content: text, expectedContent: savedProjectContents[fileName] ?? "", format: projectFileFormats[fileName] });
      await notifyLspDocumentSaved(fileName);
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
    const requestId = ++projectSearchRequest.current;
    setProjectSearchBusy(true);
    try {
      const results = await invoke<ProjectSearchResult[]>("search_project_files", { query: searchTerm });
      if (requestId !== projectSearchRequest.current) return;
      setProjectSearchResults(results);
      setMessage(`Project search found ${results.length} matching line(s).`);
    } catch (error) {
      if (requestId !== projectSearchRequest.current) return;
      const detail = String(error);
      setMessage(detail.includes("Project search cancelled")
        ? "Project search cancelled."
        : "Project search failed: " + detail);
    } finally {
      if (requestId === projectSearchRequest.current) setProjectSearchBusy(false);
    }
  }

  async function cancelProjectSearch() {
    if (!projectSearchBusy) return;
    const requestId = ++projectSearchRequest.current;
    try {
      await invoke("cancel_project_search");
      if (requestId === projectSearchRequest.current) {
        setProjectSearchBusy(false);
        setMessage("Project search cancelled.");
      }
    } catch (error) {
      if (requestId === projectSearchRequest.current) {
        setProjectSearchBusy(false);
        setMessage("Could not cancel project search: " + String(error));
      }
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
  async function applyGitHunk(hunk: GitHunk, action: "stage" | "unstage" | "discard") {
    if (action === "discard" && !window.confirm("Discard only this selected unstaged hunk from the working file? This cannot be undone.")) return;
    setGitBusy(true);
    try {
      await invoke<string>("git_apply_hunk", { patch: hunk.patch, action });
      await refreshGit();
      setMessage(action === "stage" ? "Selected hunk staged." : action === "unstage" ? "Selected hunk unstaged." : "Selected hunk discarded.");
    } catch (error) {
      setMessage("Git " + action + " hunk failed: " + String(error));
    } finally {
      setGitBusy(false);
    }
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
    if (!["py", "js", "mjs", "cjs", "go", "rs", "c", "cpp", "cc", "cxx"].includes(extension)) {
      setMessage("Run File supports Python, JavaScript, Go, Rust, C, and C++ source files."); return;
    }
    if (!window.confirm("Run " + fileName + " from the opened project? This executes project code locally. Continue only if you trust this file.")) {
      setMessage("Run File cancelled."); return;
    }
    taskAcceptEventsRef.current = true;
    taskEventBufferRef.current.begin();
    setActiveTaskId(null);
    setTaskRunning(true);
    setTaskOutput("Starting " + fileName + " …\n");
    try {
      const id = await invoke<string>("start_source_file_task", { path: fileName });
      if (taskAcceptEventsRef.current) {
        setActiveTaskId(id);
        for (const buffered of taskEventBufferRef.current.activate(id)) applyTaskEvent(buffered);
      }
      setMessage("Running " + fileName + "…");
    } catch (error) {
      taskAcceptEventsRef.current = false;
      taskEventBufferRef.current.reset();
      setActiveTaskId(null);
      setTaskRunning(false);
      setTaskOutput("Could not run file: " + String(error));
      setMessage("Run File failed to start.");
    }
  }

  async function runTask(task: string) {
    const confirmed = window.confirm(
      "Run this project command?\n\n" + task + "\n\nBuild and test commands execute code from the opened project. Only continue if you trust this project."
    );
    if (!confirmed) {
      setMessage("Project task cancelled.");
      return;
    }
    taskAcceptEventsRef.current = true;
    taskEventBufferRef.current.begin();
    setActiveTaskId(null);
    setTaskRunning(true);
    setTaskOutput("Starting " + task + " …\n");
    try {
      const id = await invoke<string>("start_project_task", { task });
      if (taskAcceptEventsRef.current) {
        setActiveTaskId(id);
        for (const buffered of taskEventBufferRef.current.activate(id)) applyTaskEvent(buffered);
      }
      setMessage("Running " + task + "…");
    } catch (error) {
      taskAcceptEventsRef.current = false;
      taskEventBufferRef.current.reset();
      setActiveTaskId(null);
      setTaskRunning(false);
      setTaskOutput("Could not start task: " + String(error));
      setMessage("Build/run task failed to start.");
    }
  }

  async function cancelTask() {
    if (!activeTaskId) return;
    try {
      const accepted = await invoke<boolean>("cancel_project_task", { taskId: activeTaskId });
      setMessage(accepted ? "Task cancellation requested…" : "Task has already finished.");
    } catch (error) {
      setMessage("Could not cancel task: " + String(error));
    }
  }

  function applyTaskEvent(event: TaskEvent) {
    if (event.kind === "output") {
      setTaskOutput(current => (current + event.data).slice(-100_000));
      return;
    }
    if (event.kind === "progress") {
      const state = event.state;
      if (state === "running") setMessage("Task is running…");
      else if (state === "cancelled") setMessage("Task cancelled.");
      else if (state === "timed_out") setMessage("Task timed out.");
      else if (state === "completed") setMessage("Task completed.");
      else if (state === "failed") setMessage("Task failed.");
      return;
    }
    const result = event.result;
    taskAcceptEventsRef.current = false;
    taskEventBufferRef.current.finish(event.task_id);
    setActiveTaskId(null);
    setTaskRunning(false);
    setTaskOutput(formatTaskOutput(result.success, result.command, result.output));
    setMessage(result.cancelled ? result.command + " cancelled."
      : result.timed_out ? result.command + " timed out."
      : result.success ? result.command + " completed."
      : result.command + " failed.");
  }

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: Array<() => void> = [];
    const receiveTaskEvent = (event: TaskEvent) => {
      if (!taskAcceptEventsRef.current) return;
      for (const accepted of taskEventBufferRef.current.push(event)) applyTaskEvent(accepted);
    };
    Promise.all([
      listen<{ task_id: string; data: string }>("task-output", event => receiveTaskEvent({ kind: "output", task_id: event.payload.task_id, data: event.payload.data })),
      listen<{ task_id: string; state: string }>("task-progress", event => receiveTaskEvent({ kind: "progress", task_id: event.payload.task_id, state: event.payload.state })),
      listen<{ task_id: string; result: TaskResult }>("task-completed", event => receiveTaskEvent({ kind: "completed", task_id: event.payload.task_id, result: event.payload.result }))
    ]).then(listeners => {
      if (!active) listeners.forEach(stop => stop());
      else unlisten = listeners;
    }).catch(error => setMessage("Could not subscribe to task events: " + String(error)));
    return () => { active = false; unlisten.forEach(stop => stop()); };
  }, []);
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
        await invoke("write_project_file", { path: name, content: body, expectedContent: savedProjectContents[name] ?? "", format: projectFileFormats[name] });
        await notifyLspDocumentSaved(name);
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
        await invoke("write_project_file", { path: name, content: "", format: { bom: false, line_ending: "lf" } });
        setProjectFileFormats(current => ({ ...current, [name]: { bom: false, line_ending: "lf" } }));
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
  function sendFeedback() {
    const categoryInput = window.prompt("Feedback type: bug, feature, or general", "general");
    if (!categoryInput) return;
    const normalized = categoryInput.trim().toLowerCase();
    const category: FeedbackCategory = normalized === "bug"
      ? "Bug report"
      : normalized === "feature"
        ? "Feature request"
        : "General feedback";
    const messageText = window.prompt("Describe your feedback. Do not include passwords, tokens, private project paths, or source code.");
    if (!messageText?.trim()) return;
    try {
      const url = createFeedbackIssueUrl({
        category,
        message: messageText,
        platform: isTauri() ? "Windows desktop" : "Browser preview",
      });
      window.open(url, "_blank", "noopener,noreferrer");
      setMessage("Review your feedback in GitHub before submitting.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not prepare feedback.");
    }
  }

  function replaceAll() {
    if (!findText) { setMessage("Enter text to find first."); return; }
    setFiles(current => ({ ...current, [fileName]: (current[fileName] ?? "").split(findText).join(replaceText) }));
    setMessage("Replace all finished in " + fileName);
  }

  return <div className="app">
    <header className="titlebar"><div className="brand"><img className="brand-logo" src="/gocode-logo.svg" alt="" /><span>Gocode <b>IDE</b></span></div><div className="title-center">Workspace <span className="muted">/</span> my-project</div><div className="window-actions"><span>—</span><span>□</span><span>×</span></div></header>
    <div className="menubar"><button onClick={() => { setNewFile(true); setPanel("Explorer"); }}>New File</button><button onClick={() => { if (isTauri()) void openNativeFile(); else document.getElementById("open-files-input")?.click(); }}>Open File</button><button onClick={() => isTauri() ? void openProjectFolder() : setMessage("Open project folder is available in the desktop app.")}>Open Project</button><input id="open-files-input" type="file" multiple hidden onChange={openFiles} /><button onClick={() => void saveCurrentFile()}>Save File</button><button onClick={downloadFile}>Download File</button><button onClick={() => { setPanel("Search"); setShowFind(true); }}>Find / Replace</button><button onClick={() => setShowTerminal(v => !v)}>Terminal Panel</button><button onClick={sendFeedback} title="Review and submit feedback through GitHub">Send Feedback</button><div className="menubar-right">Local-first · {projectRoot ? "Project open" : "No project"}</div></div>
    <div className="workarea">
      <nav className="activity">{panels.map(item => <button key={item.name} title={item.name} aria-label={item.name} className={panel === item.name ? "active" : ""} onClick={() => setPanel(item.name)}><span>{item.icon}</span></button>)}</nav>
      <aside className="sidebar"><div className="side-heading">{panel.toUpperCase()}<button title="New file" onClick={() => { setNewFile(true); setPanel("Explorer"); }}>＋</button></div>
        {panel === "Explorer" ? <>
          <div className="tree-heading">⌄　{projectRoot ? projectRoot.split(/[\\\\/]/).pop() : "MY-PROJECT"} <button title="New folder" disabled={!projectRoot || !isTauri()} onClick={() => { setNewFolder(true); setNewFile(false); }}>▱</button><button title="New file" onClick={() => { setNewFile(true); setNewFolder(false); }}>＋</button></div>{projectRoot && <div className="project-root-label" title={projectRoot}>{projectRoot}</div>}{projectRoot && <div className="project-tree-viewport" role="tree" aria-label="Project files" onScroll={event => setProjectTreeScrollTop(event.currentTarget.scrollTop)}><div aria-hidden="true" style={{ height: projectTreeWindow.offsetTop }} />{projectTreeWindow.items.map(entry => <div className={"file-row project-row " + (fileName === entry.path ? "selected" : "")} key={entry.path} style={{ paddingLeft: Math.min(7 + (entry.path.split("/").length - 1) * 12, 60) }}><button className="file-open" role="treeitem" aria-expanded={entry.is_dir ? !collapsedProjectDirs[entry.path] : undefined} onClick={() => entry.is_dir ? toggleProjectDirectory(entry.path) : void openProjectEntry(entry.path)}><span className="file-icon">{entry.is_dir ? (collapsedProjectDirs[entry.path] ? "▸" : "▾") : "◇"}</span>{entry.path.split("/").pop()}</button></div>)}<div aria-hidden="true" style={{ height: Math.max(0, projectTreeWindow.totalHeight - projectTreeWindow.offsetTop - projectTreeWindow.items.length * 27) }} /></div>}
          {Object.keys(files).sort().map(name => <div className={"file-row " + (fileName === name ? "selected" : "")} key={name}>
            <button className="file-open" onClick={() => setFileName(name)}><span className="file-icon">◇</span>{name}</button>
            <button className="file-delete" title={"Remove " + name} onClick={() => removeFile(name)}>×</button>
          </div>)}
          {newFile && <form onSubmit={createFile}><input autoFocus placeholder="filename.ext" value={draftName} onChange={e => setDraftName(e.target.value)} /><div className="form-actions"><button type="submit">Create</button><button type="button" onClick={() => setNewFile(false)}>Cancel</button></div></form>}{newFolder && <form onSubmit={createProjectFolder}><input autoFocus placeholder="folder-name or parent/child" aria-label="Folder path" value={draftFolderName} onChange={e => setDraftFolderName(e.target.value)} /><div className="form-actions"><button type="submit">Create folder</button><button type="button" onClick={() => setNewFolder(false)}>Cancel</button></div></form>}
          <div className="workspace-actions"><button onClick={exportWorkspace}>Export workspace backup</button><label className="import-button">Import backup<input type="file" accept=".json,application/json" onChange={importWorkspace} /></label></div>
        </> : panel === "Search" ? <div className="empty-panel"><label>Search workspace buffers</label><input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Text to find" />{searchTerm && matches.map(([name]) => <button className="search-result" key={name} onClick={() => { setFileName(name); setPanel("Explorer"); }}>{name}<small>Open buffer</small></button>)}<hr /><strong>Search opened project</strong><p>Searches text files up to 1 MB, skips symlinks and common generated folders, and returns at most 200 matches.</p><button disabled={!projectRoot || projectSearchBusy || !searchTerm.trim()} onClick={() => void searchProject()}>{projectSearchBusy ? "Searching…" : "Search project files"}</button>{projectSearchBusy && <button onClick={() => void cancelProjectSearch()}>Cancel search</button>}{projectSearchResults.map((result, index) => <button className="search-result" key={result.path + ":" + result.line_number + ":" + index} onClick={() => { setPendingCursor({ path: result.path, line: result.line_number }); void openProjectEntry(result.path).then(() => setMessage(`Opened ${result.path} at line ${result.line_number}.`)); }}><span>{result.path}:{result.line_number}</span><small>{result.snippet}</small></button>)}</div>
          : panel === "Source Control" ? <div className="empty-panel"><strong>Git Source Control</strong><p>{projectRoot ? "Project: " + projectRoot : "Open a project folder first."}</p><button disabled={!projectRoot || gitBusy} onClick={() => void refreshGit()}>Refresh status / diff</button><button disabled={!projectRoot || gitBusy} onClick={() => void stageGitChanges()}>Stage all changes</button><input aria-label="Commit message" placeholder="Commit message" value={commitMessage} onChange={e => setCommitMessage(e.target.value)} /><button disabled={!projectRoot || !commitMessage.trim() || gitBusy} onClick={() => void commitGitChanges()}>Commit staged changes</button><div className="git-branch-controls"><label>Local branch<select aria-label="Local branch" value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} disabled={!projectRoot || gitBusy}>{gitBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label><button disabled={!projectRoot || !selectedBranch || gitBusy || selectedBranch === gitInfo?.branch} onClick={() => void checkoutGitBranch()}>Switch branch</button></div><button disabled={!projectRoot || gitBusy} onClick={() => void syncGit("pull")}>Pull (fast-forward only)</button><button disabled={!projectRoot || gitBusy} onClick={() => void syncGit("push")}>Push current branch to origin</button>{gitInfo && <><p>Branch: {gitInfo.branch || "(detached HEAD)"}</p><pre className="output-box">{gitInfo.output}</pre><strong>Changed hunks ({gitHunks.length})</strong>{gitHunks.length ? gitHunks.map(hunk => <section className="extension-card" key={hunk.id}><strong>{hunk.path}</strong><p>{hunk.kind === "staged" ? "Staged" : "Unstaged"} · {hunk.summary}</p><pre className="output-box">{hunk.patch}</pre>{hunk.kind === "unstaged" ? <><button disabled={gitBusy} onClick={() => void applyGitHunk(hunk, "stage")}>Stage hunk</button><button disabled={gitBusy} onClick={() => void applyGitHunk(hunk, "discard")}>Discard hunk</button></> : <button disabled={gitBusy} onClick={() => void applyGitHunk(hunk, "unstage")}>Unstage hunk</button>}</section>) : <p>No tracked text-file hunks. Use Stage all changes for untracked files and binary changes.</p>}</>}{taskOutput && <pre className="output-box">{taskOutput}</pre>}<p>Git actions run locally. Pull/push require a configured remote and may use the credentials configured in Git. Remote sync asks for confirmation; branch switching only targets existing local branches.</p></div>
          : panel === "Run & Debug" ? <div className="empty-panel"><strong>Build &amp; Toolchains</strong><section className="extension-card"><strong>Language Server Protocol</strong><p>{lspSessionId ? (lspReady ? "Connected and initialized." : "Starting / initializing…") : "No language server connected."} Configure a local language-server executable you installed and trust. The IDE will launch it only after you press Start.</p><button disabled={!projectRoot || !isTauri()} onClick={() => void startLanguageServer()}>Configure &amp; Start Language Server…</button>{lspLaunchProfiles.length > 0 && <div className="debug-data"><label className="setting-row">Saved trusted server <select aria-label="Saved language-server profile" value={selectedLspProfile} onChange={event => setSelectedLspProfile(event.target.value)}><option value="">Choose a profile</option>{lspLaunchProfiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select></label><button disabled={!projectRoot || !isTauri() || !selectedLspProfile} onClick={() => { const profile = lspLaunchProfiles.find(item => item.name === selectedLspProfile); if (profile) void startLanguageServer(profile); }}>Start Saved Profile</button><button disabled={!selectedLspProfile} onClick={() => { const nextProfiles = lspLaunchProfiles.filter(item => item.name !== selectedLspProfile); try { localStorage.setItem(LSP_LAUNCH_PROFILES_KEY, JSON.stringify(nextProfiles)); setLspLaunchProfiles(nextProfiles); setSelectedLspProfile(""); } catch (error) { setMessage("Could not update saved language-server profiles: " + String(error)); } }}>Remove Profile</button></div>}<small>Trusted profiles are stored locally on this device. Secret-like arguments are not saved; configurations containing credentials must be launched for the current session only.</small><button disabled={!lspSessionId} onClick={() => void stopLanguageServer()}>Stop Language Server</button><button disabled={!isTauri() || !projectRoot || !lspLaunchConfig.current} onClick={() => void restartLanguageServer()}>Restart Language Server</button><button disabled={!lspReady || !projectRoot} onClick={() => void sendLspRequest("textDocument/hover", { textDocument: { uri: projectFileUri(projectRoot!, fileName) }, position: { line: cursorPosition.line - 1, character: cursorPosition.column - 1 } })}>Hover at Cursor</button><button disabled={!lspReady || !projectRoot} onClick={() => void sendLspRequest("textDocument/completion", { textDocument: { uri: projectFileUri(projectRoot!, fileName) }, position: { line: cursorPosition.line - 1, character: cursorPosition.column - 1 } })}>Request Completions</button><button disabled={!lspReady || !projectRoot} onClick={() => void sendLspRequest("textDocument/definition", { textDocument: { uri: projectFileUri(projectRoot!, fileName) }, position: { line: cursorPosition.line - 1, character: cursorPosition.column - 1 } })}>Go to Definition</button><button disabled={!lspReady || !projectRoot} onClick={() => { setLspReferences([]); void sendLspRequest("textDocument/references", { textDocument: { uri: projectFileUri(projectRoot!, fileName) }, position: { line: cursorPosition.line - 1, character: cursorPosition.column - 1 }, context: { includeDeclaration: true } }); }}>Find References</button>{lspHoverText && <div className="debug-data"><strong>Hover result</strong><pre className="output-box">{lspHoverText}</pre></div>}{lspReferences.length > 0 && <div className="debug-data"><strong>References ({lspReferences.length})</strong>{lspReferences.map((item, index) => <button className="search-result" key={item.path + ":" + item.line + ":" + item.column + ":" + index} onClick={() => { void (async () => { await openProjectEntry(item.path); setPendingCursor({ path: item.path, line: item.line }); window.setTimeout(() => { editorRef.current?.setPosition({ lineNumber: item.line, column: item.column }); editorRef.current?.revealPositionInCenter({ lineNumber: item.line, column: item.column }); }, 100); })(); }}><strong>{item.path}</strong><span>:{item.line}:{item.column}</span></button>)}</div>}{lspCompletions.length > 0 && <div className="debug-data"><strong>Completion results ({lspCompletions.length})</strong>{lspCompletions.map((item, index) => <button className="search-result" key={item.label + index} onClick={() => applyLspCompletion(item)} title="Insert this completion at the cursor"><strong>{item.label}</strong>{item.detail && <span> — {item.detail}</span>}{item.documentation && <p>{item.documentation}</p>}<small>Click to insert</small></button>)}</div>}{lspOutput.length > 0 && <pre className="output-box">{lspOutput.join("\n")}</pre>}</section><section className="extension-card"><strong>Debug Adapter Protocol</strong><p>{dapSessionId ? "Debug adapter state: " + dapLifecycle + ". Review the adapter event log below." : dapLifecycle === "terminated" ? "The previous debug session has terminated." : dapLifecycle === "failed" ? "The previous debug session failed. You can start a new session." : "Connect a locally installed DAP-compatible debugger. Adapter launch configuration is specific to the debugger you choose."}</p><button disabled={!isTauri()} onClick={() => void startDebugAdapter()}>Configure &amp; Start Debug Adapter…</button>{dapLaunchProfiles.length > 0 && <div className="debug-data"><label className="setting-row">Saved session profile <select aria-label="Saved debug profile" value={selectedDapProfile} onChange={event => setSelectedDapProfile(event.target.value)}>{dapLaunchProfiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name} ({profile.request})</option>)}</select></label><button disabled={!isTauri() || !selectedDapProfile} onClick={() => { const profile = dapLaunchProfiles.find(item => item.name === selectedDapProfile); if (profile) void startDebugAdapter(profile); }}>Start Saved Configuration</button><button onClick={() => { setDapLaunchProfiles(current => current.filter(item => item.name !== selectedDapProfile)); setSelectedDapProfile(""); }}>Remove Profile</button></div>}<small>Saved profiles stay in memory for this app session only; they are not written to disk because adapter configurations may contain secrets.</small><label className="setting-row">Thread ID <input aria-label="Debug thread ID" type="number" min={1} value={dapThreadId} onChange={event => setDapThreadId(Math.max(1, Number(event.target.value) || 1))} /></label><label className="setting-row">Frame ID <input aria-label="Debug frame ID" type="number" min={0} value={dapFrameId} onChange={event => setDapFrameId(Math.max(0, Number(event.target.value) || 0))} /></label><button disabled={!dapSessionId || !projectRoot} onClick={() => void toggleBreakpointAtCursor()}>{(dapBreakpoints[fileName] ?? []).includes(cursorPosition.line) ? "Remove Breakpoint at Cursor" : "Toggle Breakpoint at Cursor"}</button><span className="muted">{(dapBreakpoints[fileName] ?? []).length} breakpoint(s) for this file</span><button disabled={!dapSessionId} onClick={() => void sendDapRequest("threads")}>List Threads</button><button disabled={!dapSessionId} onClick={() => void sendDapRequest("stackTrace", { threadId: dapThreadId })}>Stack Trace</button><button disabled={!dapSessionId} onClick={() => void sendDapRequest("scopes", { frameId: dapFrameId })}>Inspect Scopes</button><label className="setting-row">Variables reference <input aria-label="Variables reference" type="number" min={1} value={dapVariablesReference} onChange={event => setDapVariablesReference(Math.max(1, Number(event.target.value) || 1))} /></label><button disabled={!dapSessionId} onClick={() => void sendDapRequest("variables", { variablesReference: dapVariablesReference })}>Inspect Variables</button><div className="debug-data"><strong>Watch Expressions</strong><form onSubmit={addWatchExpression}><input aria-label="Watch expression" placeholder="Expression to evaluate" value={dapWatchDraft} onChange={event => setDapWatchDraft(event.target.value)} maxLength={500} /><button type="submit" disabled={!dapSessionId || !dapWatchDraft.trim()}>Add Watch</button></form><button disabled={!dapSessionId || !dapWatchExpressions.length} onClick={refreshWatchExpressions}>Refresh Watches</button>{dapWatchExpressions.map(expression => <div className="watch-row" key={expression}><span><strong>{expression}</strong><small>{dapWatchValues[expression] ?? "Not evaluated"}</small></span><button onClick={() => { setDapWatchExpressions(current => current.filter(item => item !== expression)); setDapWatchValues(current => { const next = { ...current }; delete next[expression]; return next; }); }}>Remove</button></div>)}</div>{dapThreads.length > 0 && <div className="debug-data"><strong>Threads</strong>{dapThreads.map(thread => <button key={thread.id} onClick={() => { setDapThreadId(thread.id); void sendDapRequest("stackTrace", { threadId: thread.id }); }}>{thread.name} (#{thread.id})</button>)}</div>}{dapFrames.length > 0 && <div className="debug-data"><strong>Call Stack</strong>{dapFrames.map(frame => <button key={frame.id} onClick={() => { setDapFrameId(frame.id); if (frame.sourcePath && projectRoot) { const root = projectRoot.replace(/\\/g, "/").replace(/\/$/, ""); const source = frame.sourcePath.replace(/\\/g, "/"); if (source.startsWith(root + "/")) { const relative = source.slice(root.length + 1); setPendingCursor({ path: relative, line: frame.line }); setFileName(relative); } } void sendDapRequest("scopes", { frameId: frame.id }); }}>{frame.name} — {frame.line}:{frame.column}</button>)}</div>}{dapScopes.length > 0 && <div className="debug-data"><strong>Scopes</strong>{dapScopes.map((scope, index) => <button key={scope.name + index} disabled={!scope.variablesReference} onClick={() => { setDapVariablesReference(scope.variablesReference); void sendDapRequest("variables", { variablesReference: scope.variablesReference }); }}>{scope.name}{scope.expensive ? " (expensive)" : ""}</button>)}</div>}{dapVariables.length > 0 && <div className="debug-data"><strong>Variables</strong><pre className="output-box">{dapVariables.map(variable => variable.name + (variable.type ? ": " + variable.type : "") + " = " + variable.value).join("\\n")}</pre></div>}<button disabled={!dapSessionId} onClick={() => void sendDapRequest("continue", { threadId: dapThreadId })}>Continue</button><button disabled={!dapSessionId} onClick={() => void sendDapRequest("next", { threadId: dapThreadId })}>Step Over</button><button disabled={!dapSessionId} onClick={() => void sendDapRequest("stepIn", { threadId: dapThreadId })}>Step Into</button><button disabled={!dapSessionId} onClick={() => void sendDapRequest("stepOut", { threadId: dapThreadId })}>Step Out</button><button disabled={!dapSessionId} onClick={() => void sendDapRequest("pause", { threadId: dapThreadId })}>Pause</button><button disabled={!dapSessionId} onClick={() => void sendDapRequest("disconnect", { restart: false })}>Disconnect</button><button disabled={!dapSessionId} onClick={() => void stopDebugAdapter()}>Stop Adapter</button>{dapOutput.length > 0 && <pre className="output-box">{dapOutput.join("\\n")}</pre>}</section><p>{projectRoot ? "Detected project tasks:" : "Open a project folder first."}</p><button disabled={!projectRoot || taskRunning || !projectEntries.some(entry => entry.path === fileName && !entry.is_dir)} onClick={() => void runCurrentSourceFile()}>Run Current File (Python / JS / Go / Rust / C / C++)</button>{tasks.map(task => <button key={task} disabled={!projectRoot || taskRunning} onClick={() => void runTask(task)}>{taskRunning ? "Running…" : "Run " + task}</button>)}<button disabled={!activeTaskId || !taskRunning} onClick={() => void cancelTask()}>Cancel Running Task</button>{taskOutput && <pre className="output-box">{taskOutput}</pre>}<p>Runs fixed, detected build/test commands without shell interpolation. Install the relevant toolchain and make it available on PATH.</p><p>Debugging is experimental: configure a trusted local adapter and adapter-specific launch settings. Threads, call-stack frames, scopes, and variables are shown when the adapter supports those DAP responses.</p></div>
          : panel === "Extensions" ? <div className="empty-panel"><strong>Extension manifest registry</strong><p>Import JSON to review an extension's identity, publisher, license, and requested capabilities. This prototype does not install or execute extension code.</p><label className="import-button">Import manifest JSON<input type="file" accept=".json,application/json" onChange={importExtensionManifest} /></label>{extensionError && <p role="status">{extensionError}</p>}{extensions.map(ext => <section className="extension-card" key={ext.id}><strong>{ext.name} <small>v{ext.version}</small></strong><p>{ext.description}</p><p>Publisher: {ext.publisher}</p><p>License: {ext.license}</p><p>Requested capabilities: {ext.capabilities.length ? <ul className="capability-list">{reviewCapabilities(ext.capabilities).map((item, index) => <li key={item.capability + index}><strong>{item.capability}</strong> — {item.risk.toUpperCase()} RISK: {item.explanation}</li>)}</ul> : "None declared"}</p><button onClick={() => setExtensions(old => old.filter(x => x.id !== ext.id))}>Remove manifest</button></section>)}<p>Manifest claims are not verified publisher identities or license compliance guarantees.</p></div>
          : <div className="empty-panel"><strong>Editor &amp; Privacy Settings</strong><label className="setting-row"><input type="checkbox" checked={wordWrap} onChange={e => setWordWrap(e.target.checked)} /> Word wrap</label><label className="setting-row"><input type="checkbox" checked={minimap} onChange={e => setMinimap(e.target.checked)} /> Editor minimap</label><label className="setting-row">Editor font size <input aria-label="Editor font size" type="number" min={10} max={24} value={fontSize} onChange={event => setFontSize(clampEditorFontSize(Number(event.target.value)))} /></label><p>Use Ctrl+= / Ctrl+- to change font size and Ctrl+0 to reset it. The size is saved with editor preferences.</p><p>Workspace buffers, editor preferences, and extension manifests are stored in this browser profile. Export a workspace backup before clearing browser data.</p><p>External project uploads are not performed by these features. The desktop prototype can launch explicitly configured local LSP servers and DAP adapters, but support is adapter-dependent and still needs end-to-end validation. Executable extension hosting is not implemented.</p></div>}
      </aside>
      <main className="main"><div className="tabs">{openTabs.map(name => <div key={name} className={"tab " + (fileName === name ? "tab-active" : "tab-inactive")} onClick={() => setFileName(name)} title={name}><span className="file-icon">◇</span><span className="tab-name">{name}</span>{isProjectTabDirty(name) && <span className="tab-dirty" title="Unsaved project changes" aria-label="Unsaved changes">●</span>}<button className="tab-close" aria-label={"Close " + name} title={"Close " + name} onClick={event => { event.stopPropagation(); closeEditorTab(name); }}>×</button></div>)}<div className="editor-actions"><span>{lineCount} lines</span><button onClick={() => void saveAllOpenProjectFiles()} disabled={gitBusy || !openTabs.some(isProjectTabDirty)} title="Save all modified open project files">Save All</button><button onClick={downloadFile} title="Download current file">↓</button><button onClick={() => setShowTerminal(v => !v)} title="Toggle terminal">⌄</button></div></div>
        {showFind && <div className="findbar"><input aria-label="Find text" placeholder="Find text" value={findText} onChange={e => setFindText(e.target.value)} /><input aria-label="Replace text" placeholder="Replace with" value={replaceText} onChange={e => setReplaceText(e.target.value)} /><button onClick={replaceAll}>Replace all</button><button onClick={() => setShowFind(false)} title="Close find">×</button></div>}
        <div className="editor-wrap"><Editor height="100%" onMount={(editor, monaco) => { editorRef.current = editor; setDapBreakpoints(current => ({ ...current })); setCursorPosition({ line: editor.getPosition()?.lineNumber ?? 1, column: editor.getPosition()?.column ?? 1 }); editor.onDidChangeCursorPosition(event => setCursorPosition({ line: event.position.lineNumber, column: event.position.column })); editor.onMouseDown(event => { if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) { setCursorPosition({ line: event.target.position.lineNumber, column: 1 }); void toggleBreakpointAtLine(event.target.position.lineNumber); } }); }} language={languageForFile(fileName)} value={text} theme="vs-dark" onValidate={markers => setEditorDiagnostics(markers.map(marker => ({ message: marker.message, lineNumber: marker.startLineNumber, column: marker.startColumn, severity: marker.severity })))} onChange={value => setFiles(current => ({ ...current, [fileName]: value ?? "" }))} options={{ automaticLayout: true, glyphMargin: true, minimap: { enabled: minimap }, fontSize, tabSize: 2, wordWrap: wordWrap ? "on" : "off", scrollBeyondLastLine: false, renderLineHighlight: "all", padding: { top: 14, bottom: 16 }, smoothScrolling: true, bracketPairColorization: { enabled: true } }} /></div>
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
