import { useEffect, useMemo, useState, type FormEvent, type ChangeEvent } from "react";
import Editor from "@monaco-editor/react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

type Panel = "Explorer" | "Search" | "Source Control" | "Run & Debug" | "Extensions" | "Settings";
type Workspace = Record<string, string>;
const STORAGE_KEY = "gocode-ide-workspace-v1";
const welcome = "# Welcome to Gocode IDE\n\nA free, local-first development environment.\n\nThis is an early browser prototype. Files are stored in this browser. Use Download to save a copy. The real desktop filesystem, terminal, compiler, debugger, Git integration, and extension host are not implemented yet.";
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
        const result: Workspace = {};
        for (const [name, text] of Object.entries(value)) {
          if (typeof text === "string" && name.trim() && !name.split("/").includes("..")) result[name] = text;
        }
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
  const [fileName, setFileName] = useState("Welcome.md");
  const [draftName, setDraftName] = useState("");
  const [newFile, setNewFile] = useState(false);
  const [showTerminal, setShowTerminal] = useState(true);
  const [message, setMessage] = useState("Ready");
  const [searchTerm, setSearchTerm] = useState("");
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showFind, setShowFind] = useState(false);
  const text = files[fileName] ?? "";
  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const matches = useMemo(() => Object.entries(files).filter(([name, body]) =>
    (name + "\n" + body).toLowerCase().includes(searchTerm.toLowerCase())), [files, searchTerm]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(files)); }
    catch { setMessage("Browser storage is full. Download your files for backup."); }
  }, [files]);

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
  async function openNativeFile() {\n    try {\n      const selected = await openDialog({ multiple: false, directory: false, filters: [{ name: "Source files", extensions: ["txt", "md", "ts", "tsx", "js", "jsx", "json", "html", "css", "py", "rs", "c", "cpp", "h", "java", "go", "yaml", "yml", "toml", "xml", "sql", "sh"] }] });\n      if (!selected || Array.isArray(selected)) return;\n      const contents = await readTextFile(selected);\n      const name = selected.split(/[\\\\/]/).pop() || "Untitled.txt";\n      setFiles(current => ({ ...current, [name]: contents }));\n      setNativePaths(current => ({ ...current, [name]: selected }));\n      setFileName(name); setPanel("Explorer"); setMessage("Opened " + name);\n    } catch (error) { setMessage("Open failed: " + String(error)); }\n  }\n  async function saveCurrentFile() {\n    if (!isTauri()) { downloadFile(); return; }\n    try {\n      const path = nativePaths[fileName] ?? await saveDialog({ defaultPath: fileName, filters: [{ name: "Text and source files", extensions: [fileName.split(".").pop() || "txt"] }] });\n      if (!path || typeof path !== "string") return;\n      await writeTextFile(path, text);\n      setNativePaths(current => ({ ...current, [fileName]: path }));\n      setMessage("Saved " + fileName);\n    } catch (error) { setMessage("Save failed: " + String(error)); }\n  }\n  function createFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draftName.trim().replace(/^\/+/, "");
    if (!name || name.split("/").some(part => !part || part === "." || part === "..")) {
      setMessage("Enter a valid relative file name."); return;
    }
    if (Object.prototype.hasOwnProperty.call(files, name)) {
      setMessage("That file already exists."); return;
    }
    setFiles(current => ({ ...current, [name]: "" }));
    setFileName(name); setDraftName(""); setNewFile(false); setPanel("Explorer");
    setMessage("Created " + name);
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
    if (!selected.length) return;
    let remaining = selected.length;
    const imported: Workspace = {};
    for (const file of selected) {
      const reader = new FileReader();
      reader.onload = () => {
        imported[file.name] = String(reader.result ?? "");
        remaining -= 1;
        if (remaining === 0) {
          setFiles(current => ({ ...current, ...imported }));
          setFileName(selected[selected.length - 1].name);
          setPanel("Explorer");
          setMessage("Opened " + selected.length + " file(s) into the browser workspace.");
        }
      };
      reader.onerror = () => { remaining -= 1; if (remaining === 0) setMessage("Some files could not be read."); };
      reader.readAsText(file);
    }
    event.target.value = "";
  }
  function exportWorkspace() {
    download("gocode-workspace.json", JSON.stringify({ app: "Gocode IDE", version: 1, files }, null, 2), "application/json");
    setMessage("Workspace backup downloaded.");
  }
  function importWorkspace(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const value: unknown = JSON.parse(String(reader.result));
        if (!value || typeof value !== "object" || !("files" in value) ||
            !value.files || typeof value.files !== "object" || Array.isArray(value.files)) throw new Error("Invalid backup");
        const result: Workspace = {};
        for (const [name, body] of Object.entries(value.files)) {
          if (typeof body === "string" && name.trim() && !name.split("/").includes("..")) result[name] = body;
        }
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
    <div className="menubar"><button onClick={() => { setNewFile(true); setPanel("Explorer"); }}>New File</button><button onClick={() => { if (isTauri()) void openNativeFile(); else document.getElementById("open-files-input")?.click(); }}>Open File</button><input id="open-files-input" type="file" multiple hidden onChange={openFiles} /><button onClick={() => void saveCurrentFile()}>Save File</button><button onClick={downloadFile}>Download File</button><button onClick={() => { setPanel("Search"); setShowFind(true); }}>Find / Replace</button><button onClick={() => setShowTerminal(v => !v)}>Terminal Panel</button><div className="menubar-right">Browser prototype · Local-first</div></div>
    <div className="workarea">
      <nav className="activity">{panels.map(item => <button key={item.name} title={item.name} aria-label={item.name} className={panel === item.name ? "active" : ""} onClick={() => setPanel(item.name)}><span>{item.icon}</span></button>)}</nav>
      <aside className="sidebar"><div className="side-heading">{panel.toUpperCase()}<button title="New file" onClick={() => { setNewFile(true); setPanel("Explorer"); }}>＋</button></div>
        {panel === "Explorer" ? <>
          <div className="tree-heading">⌄　MY-PROJECT <button title="New file" onClick={() => setNewFile(true)}>＋</button></div>
          {Object.keys(files).sort().map(name => <div className={"file-row " + (fileName === name ? "selected" : "")} key={name}>
            <button className="file-open" onClick={() => setFileName(name)}><span className="file-icon">◇</span>{name}</button>
            <button className="file-delete" title={"Remove " + name} onClick={() => removeFile(name)}>×</button>
          </div>)}
          {newFile && <form onSubmit={createFile}><input autoFocus placeholder="filename.ext" value={draftName} onChange={e => setDraftName(e.target.value)} /><div className="form-actions"><button type="submit">Create</button><button type="button" onClick={() => setNewFile(false)}>Cancel</button></div></form>}
          <div className="workspace-actions"><button onClick={exportWorkspace}>Export workspace backup</button><label className="import-button">Import backup<input type="file" accept=".json,application/json" onChange={importWorkspace} /></label></div>
        </> : panel === "Search" ? <div className="empty-panel"><label>Search filenames and contents</label><input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Search workspace" />{searchTerm && matches.map(([name]) => <button className="search-result" key={name} onClick={() => { setFileName(name); setPanel("Explorer"); }}>{name}<small>Open file</small></button>)}</div>
          : panel === "Source Control" ? <div className="empty-panel">Source Control<p>Git integration is not implemented yet.</p></div>
          : panel === "Run & Debug" ? <div className="empty-panel">Run &amp; Debug<p>A real debugger and program runner are not connected yet.</p></div>
          : panel === "Extensions" ? <div className="empty-panel">Extensions<p>Extension installation and marketplace are not implemented yet.</p></div>
          : <div className="empty-panel">Settings<p>Workspace buffers are stored locally in this browser. Export a backup to keep a portable copy.</p><p>Gocode IDE is designed to remain free and local-first.</p></div>}
      </aside>
      <main className="main"><div className="tabs"><div className="tab"><span className="file-icon">◇</span>{fileName}<button onClick={downloadFile} title="Download current file">↓</button></div><div className="editor-actions"><span>{lineCount} lines</span><button onClick={() => setShowTerminal(v => !v)} title="Toggle terminal">⌄</button></div></div>
        {showFind && <div className="findbar"><input aria-label="Find text" placeholder="Find text" value={findText} onChange={e => setFindText(e.target.value)} /><input aria-label="Replace text" placeholder="Replace with" value={replaceText} onChange={e => setReplaceText(e.target.value)} /><button onClick={replaceAll}>Replace all</button><button onClick={() => setShowFind(false)} title="Close find">×</button></div>}
        <div className="editor-wrap"><Editor height="100%" language={languageForFile(fileName)} value={text} theme="vs-dark" onChange={value => setFiles(current => ({ ...current, [fileName]: value ?? "" }))} options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 13, tabSize: 2, wordWrap: "off", scrollBeyondLastLine: false, renderLineHighlight: "all", padding: { top: 14, bottom: 16 }, smoothScrolling: true, bracketPairColorization: { enabled: true } }} /></div>
        <div className={"bottom " + (!showTerminal ? "collapsed" : "")}><div className="bottom-tabs"><button className="bottom-active">PROBLEMS <span>0</span></button><button>OUTPUT</button><button>DEBUG CONSOLE</button><button className="bottom-active">TERMINAL</button><button className="push" onClick={() => setShowTerminal(false)}>×</button></div>{showTerminal && <div className="terminal-body"><div><span className="prompt">›</span> Gocode IDE workspace prototype</div><div className="terminal-note">This panel is a placeholder, not a real system shell. Running programs is not available yet.</div></div>}</div>
      </main>
    </div>
    <footer><span>● {message}</span><span>Browser storage</span><span>UTF-8</span><span>Ctrl+S Download · Ctrl+N New · Ctrl+F Find</span><span className="push">Gocode IDE · Free and local-first</span></footer>
  </div>;
}
