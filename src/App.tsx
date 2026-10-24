import { useEffect, useState } from "react";

type Panel = "Explorer" | "Search" | "Source Control" | "Run & Debug" | "Extensions" | "Settings";
const panels: {name: Panel; icon: string}[] = [
  {name:"Explorer",icon:"▤"},{name:"Search",icon:"⌕"},{name:"Source Control",icon:"⑂"},
  {name:"Run & Debug",icon:"▷"},{name:"Extensions",icon:"▦"},{name:"Settings",icon:"⚙"}
];

export default function App() {
  const [panel, setPanel] = useState<Panel>("Explorer");
  const [fileName, setFileName] = useState("Welcome.md");
  const [text, setText] = useState(() => localStorage.getItem("gocode-ide-editor-text") ?? "# Welcome to Gocode IDE\n\nA free, local-first development environment.\n\n## Getting started\n\nCreate a file or start writing here. This editor is an early prototype.");
  const [files, setFiles] = useState(["Welcome.md"]);
  const [showTerminal, setShowTerminal] = useState(true);
  const [terminalText, setTerminalText] = useState("Gocode IDE terminal panel prototype.\nA real system terminal is not connected yet.");
  const [newFile, setNewFile] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [saved, setSaved] = useState(true);
  useEffect(() => { localStorage.setItem("gocode-ide-editor-text", text); }, [text]);
  function createFile() {
    const name = draftName.trim();
    if (!name) return;
    if (!files.includes(name)) setFiles([...files, name]);
    setFileName(name); setText(""); setSaved(false); setDraftName(""); setNewFile(false);
  }
  return <div className="app">
    <header className="titlebar"><div className="brand"><span className="brand-mark">G</span><span>Gocode <b>IDE</b></span></div><div className="title-center">Workspace <span className="muted">/</span> my-project</div><div className="window-actions"><span>—</span><span>□</span><span>×</span></div></header>
    <div className="menubar"><span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Run</span><span>Terminal</span><span>Help</span><div className="menubar-right">Early prototype · Local-first</div></div>
    <div className="workarea">
      <nav className="activity">{panels.map(p=><button key={p.name} title={p.name} className={panel===p.name?"active":""} onClick={()=>setPanel(p.name)}><span>{p.icon}</span></button>)}</nav>
      <aside className="sidebar"><div className="side-heading">{panel.toUpperCase()}<button title="New file" onClick={()=>setNewFile(true)}>＋</button></div>
        {panel==="Explorer" ? <><div className="tree-heading">⌄　MY-PROJECT <button onClick={()=>setNewFile(true)}>＋</button></div>{files.map(f=><button key={f} className={"file-row "+(fileName===f?"selected":"")} onClick={()=>{setFileName(f);setText(f==="Welcome.md"?"# Welcome to Gocode IDE\n\nA free, local-first development environment.\n\nThis is a prototype editor buffer.":text);}}><span className="file-icon">◇</span>{f}</button>)}{newFile&&<form onSubmit={e=>{e.preventDefault();createFile()}}><input autoFocus placeholder="filename.ext" value={draftName} onChange={e=>setDraftName(e.target.value)} /><div className="form-actions"><button type="submit">Create</button><button type="button" onClick={()=>setNewFile(false)}>Cancel</button></div></form>}</>:
        panel==="Search"?<div className="empty-panel">Search workspace<br/><input placeholder="Search (prototype)" /></div>:
        panel==="Source Control"?<div className="empty-panel">Source control<br/><p>Git integration is not connected yet.</p></div>:
        panel==="Run & Debug"?<div className="empty-panel">Run and Debug<br/><p>Debugger integration is not implemented yet.</p></div>:
        panel==="Extensions"?<div className="empty-panel">Extensions<br/><p>Extension installation is not implemented yet.</p></div>:
        <div className="empty-panel">Settings<br/><p>Preferences will appear here in a future milestone.</p></div>}
      </aside>
      <main className="main"><div className="tabs"><div className="tab"><span className="file-icon">◇</span>{fileName}{!saved&&<i>●</i>}<button onClick={()=>{const blob=new Blob([text],{type:"text/plain;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=fileName;a.click();URL.revokeObjectURL(url);setSaved(true)}} title="Download current file">↓</button></div><div className="editor-actions"><button onClick={()=>setShowTerminal(!showTerminal)} title="Toggle terminal">⌄</button><button onClick={()=>{setText(text+"\n");setSaved(false)}} title="Insert line">＋</button></div></div>
        <div className="editor-wrap"><div className="line-numbers">{text.split("\n").map((_,i)=><div key={i}>{i+1}</div>)}</div><textarea aria-label="Editor prototype" spellCheck={false} value={text} onChange={e=>{setText(e.target.value);setSaved(false)}} /></div>
        <div className={"bottom "+(!showTerminal?"collapsed":"")}><div className="bottom-tabs"><button className="bottom-active">PROBLEMS <span>0</span></button><button>OUTPUT</button><button>DEBUG CONSOLE</button><button className="bottom-active">TERMINAL</button><button className="push" onClick={()=>setShowTerminal(false)}>×</button></div>{showTerminal&&<div className="terminal-body"><div><span className="prompt">›</span> {terminalText}</div><div className="terminal-note">Note: this is a UI placeholder, not a real shell.</div></div>}</div>
      </main>
    </div>
    <footer><span>● Ready</span><span>main*</span><span>UTF-8</span><span>TypeScript UI prototype</span><span className="push">Gocode IDE · Free and local-first</span></footer>
  </div>;
}
