import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { matchPath, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { createAgent, createCustomTool, deleteAgent, deleteLibraryTool, deleteToolSource, getAgents, getAnalytics, getConversation, getConversations, getTools, getToolsForSource, getToolSources, registerMcpSource, streamChat, testLibraryTool, testToolSource, updateAgent, updateMcpSource } from "./api";
import type { Agent, AgentCreate, AgentTool, AgentUpdate, AnalyticsReport, ChartContent, ChatEvent, ChatMessage, Conversation, ConversationSummary, ToolDefinition, ToolEffect, ToolSource, ToolTestResult, UserProfile } from "./types";

const USER_PROFILE: UserProfile = { name: "Neeraj Sharma", emailId: "neerajs28288@gmail.com" };

function isChartContent(value: unknown): value is ChartContent {
  return Boolean(value && typeof value === "object" && (value as ChartContent).library === "highcharts"
    && typeof (value as ChartContent).options === "object" && (value as ChartContent).options);
}

type JsonSchema = Record<string, unknown>;

function schemaRecord(value: unknown): JsonSchema {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonSchema : {};
}

function schemaType(schema: JsonSchema): string {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.filter((value): value is string => typeof value === "string").join(" | ");
  if (schema.properties) return "object";
  return "any";
}

function schemaExample(schemaValue: unknown): unknown {
  const schema = schemaRecord(schemaValue);
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = schemaType(schema).split(" | ")[0];
  if (type === "object") return Object.fromEntries(Object.entries(schemaRecord(schema.properties)).map(([name, child]) => [name, schemaExample(child)]));
  if (type === "array") return [schemaExample(schema.items)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return "example";
}

function toolInputFields(schemaValue: unknown): Array<{ name: string; schema: JsonSchema; required: boolean }> {
  const schema = schemaRecord(schemaValue);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  return Object.entries(schemaRecord(schema.properties)).map(([name, fieldSchema]) => ({ name, schema: schemaRecord(fieldSchema), required: required.has(name) }));
}

function ChartView({ content }: { content: unknown }) {
  if (!isChartContent(content)) {
    return <pre className="json-view">{JSON.stringify(content, null, 2)}</pre>;
  }
  return <figure className="chart-view"><HighchartsReact highcharts={Highcharts} options={content.options as Highcharts.Options} /></figure>;
}

function AvailabilityDot({ status }: { status: string }) {
  const available = status === "available";
  const label = available ? "Available" : status === "unavailable" ? "Unavailable" : "Error";
  return <span className={`availability-dot ${available ? "available" : "error"}`} role="img" aria-label={label} title={label} />;
}

type MarketplaceActionIconName = "connect" | "create" | "refresh" | "edit" | "trash" | "save" | "user-plus" | "play" | "json" | "close";

function MarketplaceActionIcon({ name }: { name: MarketplaceActionIconName }) {
  const paths = {
    connect: <><path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5M18 17h4M20 15v4" /></>,
    create: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" /><path d="M19 3v4M17 5h4" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9M5.5 15A7 7 0 0 0 18 17.5l2-2.5" /></>,
    edit: <><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
    save: <><path d="M5 3h12l2 2v16H5V3Z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></>,
    "user-plus": <><circle cx="9" cy="8" r="4" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M19 8v6M16 11h6" /></>,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    json: <><path d="M6 3h9l3 3v15H6V3Z" /><path d="M15 3v4h4M10 10c-1 0-1 .8-1 2s0 2-1 2c1 0 1 .8 1 2s0 2 1 2M14 10c1 0 1 .8 1 2s0 2 1 2c-1 0-1 .8-1 2s0 2-1 2" /></>,
    close: <path d="M6 6l12 12M18 6 6 18" />,
  };
  return <svg className="marketplace-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function ToastBar({ toast, onClose }: { toast: { type: "success" | "error"; message: string }; onClose: () => void }) {
  return <div className={`toast-bar ${toast.type}`} role={toast.type === "error" ? "alert" : "status"}><span>{toast.message}</span><button type="button" onClick={onClose} aria-label="Close notification" title="Close notification"><MarketplaceActionIcon name="close" /></button></div>;
}

function MessageContent({ message }: { message: ChatMessage }) {
  if (message.type === "json" || message.type === "tool") return <pre className="json-view">{JSON.stringify(message.content, null, 2)}</pre>;
  if (message.type === "chart") return <ChartView content={message.content} />;
  if (message.type === "html") return <iframe className="html-preview" sandbox="" title="Model HTML response" srcDoc={String(message.content)} />;
  return <div className="message-text markdown-content"><ReactMarkdown>{String(message.content)}</ReactMarkdown></div>;
}

function responseText(message: ChatMessage) {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
}

function MessageActions({ message, executionEvents, executionAgentName, executionStatus }: { message: ChatMessage; executionEvents?: ChatEvent[]; executionAgentName?: string; executionStatus?: "completed" | "failed" }) {
  const [status, setStatus] = useState("");
  const [showSteps, setShowSteps] = useState(false);

  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(success);
    } catch {
      setStatus("Could not access clipboard");
    }
    window.setTimeout(() => setStatus(""), 1800);
  }

  return <><div className="message-actions">
    <button type="button" onClick={() => void copy(responseText(message), "Copied")}>Copy</button>
    <button type="button" onClick={() => void copy(window.location.href, "Link copied")}>Share</button>
    {executionEvents?.length ? <button type="button" aria-expanded={showSteps} onClick={() => setShowSteps((visible) => !visible)}>{showSteps ? "Hide steps" : "Show steps"}</button> : null}
    <span aria-live="polite">{status}</span>
  </div>{showSteps && executionEvents?.length ? <ExecutionTrace events={executionEvents} agentName={executionAgentName ?? "Agent"} status={executionStatus ?? "completed"} /> : null}</>;
}

function MarkdownPromptEditor({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  const [preview, setPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function replaceSelection(before: string, after: string, fallback: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    const nextValue = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    onChange(nextValue);
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  function prefixLines(prefix: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const selected = value.slice(lineStart, end) || "List item";
    const formatted = selected.split("\n").map((line) => `${prefix}${line}`).join("\n");
    onChange(`${value.slice(0, lineStart)}${formatted}${value.slice(end)}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  return <section className="markdown-editor"><div className="editor-heading"><strong>{label}</strong><div role="group" aria-label={`${label} mode`}><button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>Edit</button><button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button></div></div>{preview ? <div className="markdown-preview">{value.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown> : <p>Nothing to preview.</p>}</div> : <><div className="markdown-toolbar" role="toolbar" aria-label={`${label} formatting`}><button type="button" title="Heading" onClick={() => prefixLines("## ")}>H</button><button type="button" title="Bold" onClick={() => replaceSelection("**", "**", "bold text")}><strong>B</strong></button><button type="button" title="Italic" onClick={() => replaceSelection("_", "_", "italic text")}><em>I</em></button><button type="button" title="Bulleted list" onClick={() => prefixLines("- ")}>• List</button><button type="button" title="Numbered list" onClick={() => prefixLines("1. ")}>1. List</button><button type="button" title="Task list" onClick={() => prefixLines("- [ ] ")}>☐ Task</button><button type="button" title="Link" onClick={() => replaceSelection("[", "](https://example.com)", "link text")}>Link</button><button type="button" title="Inline code" onClick={() => replaceSelection("`", "`", "code")}>Code</button><button type="button" title="Code block" onClick={() => replaceSelection("```\n", "\n```", "code")}>Block</button></div><textarea ref={textareaRef} value={value} onChange={(event) => onChange(event.target.value)} rows={9} placeholder={placeholder} /></>}</section>;
}

function PythonEditor({ value, onChange, label = "Python source" }: { value: string; onChange: (value: string) => void; label?: string }) {
  return <label className="python-editor"><span>{label}</span><CodeMirror value={value} height="190px" extensions={[python()]} onChange={onChange} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: true }} /></label>;
}

function createConversation(agentId: string): Conversation {
  return { id: crypto.randomUUID(), agentId, historyLoaded: true, title: "New conversation", messages: [] };
}

function conversationPath(sessionId: string) {
  return `/conversations/${encodeURIComponent(sessionId)}`;
}

function conversationFromSummary(summary: ConversationSummary): Conversation {
  return {
    id: `saved:${summary.session_id}`,
    agentId: summary.agent_id,
    sessionId: summary.session_id,
    chatSequenceId: summary.interaction_count,
    historyLoaded: false,
    title: summary.title || "New conversation",
    messages: [],
  };
}

function formatMessageTime(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const datePart = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const timePart = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${datePart} · ${timePart}`;
}

function executionEventStatus(event: ChatEvent) {
  if (event.type.includes("error") || event.type.includes("unavailable")) return "error";
  if (event.type === "final" || event.type === "complete" || event.type.includes(".end") || event.type.includes("success")) return "success";
  return "running";
}

function executionToolName(event: ChatEvent) {
  if (typeof event.tool_name === "string") return event.tool_name;
  const payload = event.payload;
  if (payload && typeof payload.tool_name === "string") return payload.tool_name;
  const serialized = payload?.serialized;
  if (serialized && typeof serialized === "object" && "name" in serialized && typeof serialized.name === "string") return serialized.name;
  return null;
}

function ExecutionTrace({ events, agentName, status, onClose }: { events: ChatEvent[]; agentName: string; status: "running" | "completed" | "failed"; onClose?: () => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (status === "running") listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [events, status]);
  return <section className="execution-trace" aria-live={status === "running" ? "polite" : "off"}><header><div><strong>{agentName} execution</strong><span>{events.length} events · {status}</span></div><span className="execution-header-actions"><i className={`execution-pulse ${status}`} aria-label={status} />{onClose ? <button type="button" className="execution-close" onClick={onClose} aria-label="Close execution steps" title="Close execution steps">×</button> : null}</span></header><div className="execution-events" ref={listRef}>{events.map((event, index) => { const eventStatus = executionEventStatus(event); const toolName = executionToolName(event); return <details className={`execution-event ${eventStatus}`} key={`${String(event.event_id ?? index)}-${event.type}`}><summary><i /><code>{event.type}{toolName ? ` · ${toolName}` : ""}</code><span>#{String(event.event_id ?? index + 1)}</span><time>{event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "Now"}</time></summary><pre>{JSON.stringify(event, null, 2)}</pre></details>; })}</div></section>;
}

function LiveExecutionTrace({ events, agentName, status }: { events: ChatEvent[]; agentName: string; status: "running" | "completed" | "failed" }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return <button type="button" className="execution-reopen" onClick={() => setVisible(true)} aria-label={`Show ${events.length} execution events`}><i className={`execution-pulse ${status}`} aria-hidden="true" /><span>Show steps</span><small>{events.length} events</small></button>;
  return <ExecutionTrace events={events} agentName={agentName} status={status} onClose={() => setVisible(false)} />;
}

function agentInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "AI";
}

type ModelOption = { id: string; type: Agent["model_type"]; label: string; available: boolean };
const MODEL_OPTIONS: ModelOption[] = [
  { id: "gpt-5.4-mini", type: "openai", label: "GPT-5.4 mini (OpenAI)", available: true },
  { id: "llama3.2:3b", type: "ollama", label: "Llama 3.2 3B (Ollama)", available: true },
  { id: "gpt-5.4", type: "openai", label: "GPT-5.4 (OpenAI)", available: false },
  { id: "claude-sonnet-4.5", type: "openai", label: "Claude Sonnet 4.5 (Anthropic)", available: false },
  { id: "gemini-2.5-pro", type: "openai", label: "Gemini 2.5 Pro (Google)", available: false },
  { id: "mistral-large", type: "openai", label: "Mistral Large (Mistral)", available: false },
];

const MARKETPLACE_APPS = [
  { name: "Wealth Manager Monitor", category: "Wealth", icon: "WM", description: "Monitor portfolios, allocations, performance, and client wealth goals." },
  { name: "Portfolio Analysis", category: "Investments", icon: "PA", description: "Review diversification, concentration, returns, and portfolio risk." },
  { name: "Market Risk Monitor", category: "Risk", icon: "MR", description: "Track market exposure, volatility, drawdowns, and emerging risk signals." },
  { name: "Stock Research", category: "Research", icon: "SR", description: "Summarize company fundamentals, market context, and investment considerations." },
  { name: "Retirement Planner", category: "Planning", icon: "RP", description: "Explore retirement targets, contribution scenarios, and income readiness." },
  { name: "Tax Impact Analyzer", category: "Tax", icon: "TA", description: "Estimate how portfolio decisions may affect realized gains and tax exposure." },
];

type McpServer = { name: string; description: string; endpoint: string; transport: string };
type MarketplaceTool = AgentTool;

const MARKETPLACE_MCP_SERVERS: McpServer[] = [
  { name: "Market Data MCP", description: "Live quotes, historical prices, and market indices for investment workflows.", endpoint: "https://mcp.example.com/market-data", transport: "Streamable HTTP" },
  { name: "Portfolio Data MCP", description: "Connect holdings, balances, transactions, and account-level portfolio data.", endpoint: "https://mcp.example.com/portfolios", transport: "Streamable HTTP" },
  { name: "Financial News MCP", description: "Search current company, sector, and macroeconomic news from one source.", endpoint: "https://mcp.example.com/news", transport: "SSE" },
];

const MARKETPLACE_TOOLS: MarketplaceTool[] = [
  { name: "get_stock_price", description: "Retrieve the latest available market price for a ticker.", source_code: "def get_stock_price(symbol: str): ...", enabled: true },
  { name: "calculate_net_worth", description: "Calculate net worth from cash balances and current stock holdings.", source_code: "def calculate_net_worth(holdings: list, cash: float): ...", enabled: true },
  { name: "portfolio_risk", description: "Summarize allocation, concentration, and volatility risk for a portfolio.", source_code: "def portfolio_risk(holdings: list): ...", enabled: true },
];

function Marketplace() {
  const [tab, setTab] = useState<"apps" | "mcp" | "tools">("apps");
  const [search, setSearch] = useState("");
  const [mcpServers, setMcpServers] = useState(MARKETPLACE_MCP_SERVERS);
  const [tools, setTools] = useState(MARKETPLACE_TOOLS);
  const [dialog, setDialog] = useState<"mcp" | "tool" | null>(null);
  const [formError, setFormError] = useState("");
  const [mcpForm, setMcpForm] = useState<McpServer>({ name: "", description: "", endpoint: "", transport: "Streamable HTTP" });
  const [toolForm, setToolForm] = useState<MarketplaceTool>({ name: "", description: "", source_code: "", enabled: true });

  function closeDialog() { setDialog(null); setFormError(""); }
  function registerMcp(event: FormEvent) {
    event.preventDefault();
    if (!mcpForm.name.trim() || !mcpForm.description.trim() || !mcpForm.endpoint.trim()) { setFormError("Name, description, and endpoint are required."); return; }
    try { new URL(mcpForm.endpoint); } catch { setFormError("Enter a valid endpoint URL."); return; }
    setMcpServers((items) => [...items, { ...mcpForm, name: mcpForm.name.trim(), description: mcpForm.description.trim(), endpoint: mcpForm.endpoint.trim() }]);
    setMcpForm({ name: "", description: "", endpoint: "", transport: "Streamable HTTP" }); closeDialog();
  }
  function createTool(event: FormEvent) {
    event.preventDefault();
    if (!toolForm.name.trim() || !toolForm.description.trim() || !toolForm.source_code.trim()) { setFormError("Name, description, and Python source are required."); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(toolForm.name.trim())) { setFormError("Tool name must be a valid Python identifier."); return; }
    setTools((items) => [...items, { ...toolForm, name: toolForm.name.trim(), description: toolForm.description.trim(), source_code: toolForm.source_code.trim() }]);
    setToolForm({ name: "", description: "", source_code: "", enabled: true }); closeDialog();
  }

  const query = search.trim().toLocaleLowerCase();
  const byName = <T extends { name: string }>(left: T, right: T) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  const apps = MARKETPLACE_APPS.filter((app) => !query || [app.name, app.description, app.category].some((value) => value.toLocaleLowerCase().includes(query))).sort(byName);
  const visibleMcpServers = mcpServers.filter((server) => !query || [server.name, server.description, server.endpoint, server.transport].some((value) => value.toLocaleLowerCase().includes(query))).sort(byName);
  const visibleTools = tools.filter((tool) => !query || [tool.name, tool.description, tool.source_code, tool.enabled ? "enabled" : "disabled"].some((value) => value.toLocaleLowerCase().includes(query))).sort(byName);
  const resultCount = tab === "apps" ? apps.length : tab === "mcp" ? visibleMcpServers.length : visibleTools.length;

  return <section className="content-page marketplace-page"><header className="content-page-header"><div><p className="eyebrow">DISCOVER</p><h1>Marketplace</h1><p>Explore apps, integrations, and reusable tools for AI Harness agents.</p></div>{tab === "mcp" ? <button className="primary-button" onClick={() => setDialog("mcp")}>Register MCP Server</button> : tab === "tools" ? <button className="primary-button" onClick={() => setDialog("tool")}>Create a Tool</button> : null}</header>
    <div className="marketplace-toolbar"><div className="marketplace-tabs" role="tablist" aria-label="Marketplace categories" onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const tabs = ["apps", "mcp", "tools"] as const; const next = (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length; setTab(tabs[next]); requestAnimationFrame(() => document.getElementById(`marketplace-tab-${tabs[next]}`)?.focus()); }}>{([ ["apps", "Apps"], ["mcp", "MCP Servers"], ["tools", "Agent Tools"] ] as const).map(([id, label]) => <button id={`marketplace-tab-${id}`} type="button" role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls={`marketplace-${id}`} className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}>{label}</button>)}</div><label className="catalog-search marketplace-search"><span className="sr-only">Search marketplace</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search marketplace" /></label></div>
    <div id={`marketplace-${tab}`} role="tabpanel" aria-labelledby={`marketplace-tab-${tab}`} className="marketplace-grid">
      {tab === "apps" && apps.map((app) => <article className="marketplace-card app-card" key={app.name}><div className="marketplace-icon" aria-hidden="true">{app.icon}</div><div className="marketplace-card-content"><span className="marketplace-category">{app.category}</span><h2>{app.name}</h2><p>{app.description}</p></div><span className="sample-badge">Sample app</span></article>)}
      {tab === "mcp" && visibleMcpServers.map((server) => <article className="marketplace-card catalog-card" key={`${server.name}-${server.endpoint}`}><div className="marketplace-icon" aria-hidden="true">MCP</div><div className="marketplace-card-content"><span className="marketplace-category">{server.transport}</span><h2>{server.name}</h2><p>{server.description}</p><code>{server.endpoint}</code></div></article>)}
      {tab === "tools" && visibleTools.map((tool) => <article className="marketplace-card catalog-card" key={tool.name}><div className="marketplace-icon" aria-hidden="true">AT</div><div className="marketplace-card-content"><span className="marketplace-category">{tool.enabled ? "Enabled" : "Disabled"}</span><h2>{tool.name}</h2><p>{tool.description}</p><code>{tool.source_code}</code></div></article>)}
      {resultCount === 0 && <p className="catalog-empty">No marketplace items match “{search.trim()}”.</p>}
    </div>
    {dialog && <div className="marketplace-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}><section className="marketplace-dialog" role="dialog" aria-modal="true" aria-labelledby="marketplace-dialog-title"><div className="agent-modal-header"><div><p className="eyebrow">MARKETPLACE</p><h1 id="marketplace-dialog-title">{dialog === "mcp" ? "Register MCP Server" : "Create a Tool"}</h1></div><button className="modal-close" type="button" onClick={closeDialog} aria-label="Close dialog">×</button></div>
      {dialog === "mcp" ? <form className="marketplace-form" onSubmit={registerMcp}><label>Name<input value={mcpForm.name} onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })} /></label><label>Description<textarea rows={3} value={mcpForm.description} onChange={(event) => setMcpForm({ ...mcpForm, description: event.target.value })} /></label><label>Endpoint URL<input type="url" placeholder="https://mcp.example.com/server" value={mcpForm.endpoint} onChange={(event) => setMcpForm({ ...mcpForm, endpoint: event.target.value })} /></label><label>Transport<select value={mcpForm.transport} onChange={(event) => setMcpForm({ ...mcpForm, transport: event.target.value })}><option>Streamable HTTP</option><option>SSE</option></select></label>{formError && <div className="error-banner">{formError}</div>}<div className="marketplace-form-actions"><button type="button" className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" type="submit">Register</button></div></form>
      : <form className="marketplace-form" onSubmit={createTool}><label>Name<input placeholder="get_stock_price" value={toolForm.name} onChange={(event) => setToolForm({ ...toolForm, name: event.target.value })} /></label><label>Description<textarea rows={3} value={toolForm.description} onChange={(event) => setToolForm({ ...toolForm, description: event.target.value })} /></label><PythonEditor value={toolForm.source_code} onChange={(value) => setToolForm({ ...toolForm, source_code: value })} /><label className="checkbox-label"><input type="checkbox" checked={toolForm.enabled} onChange={(event) => setToolForm({ ...toolForm, enabled: event.target.checked })} /> Enabled</label>{formError && <div className="error-banner">{formError}</div>}<div className="marketplace-form-actions"><button type="button" className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" type="submit">Create Tool</button></div></form>}
    </section></div>}
  </section>;
}

function ToolLibraryMarketplace({ agents, onUpdated }: { agents: Agent[]; onUpdated: (agent: Agent) => void }) {
  const [tab, setTab] = useState<"apps" | "connections" | "tools">("connections");
  const [sources, setSources] = useState<ToolSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [mcpSearch, setMcpSearch] = useState("");
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [search, setSearch] = useState("");
  const [connection, setConnection] = useState("");
  const [dialog, setDialog] = useState<"mcp" | "custom" | null>(null);
  const [editingSource, setEditingSource] = useState<ToolSource | null>(null);
  const [refreshingSourceId, setRefreshingSourceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ToolDefinition | null>(null);
  const [toolModalTab, setToolModalTab] = useState<"info" | "test">("info");
  const [testInput, setTestInput] = useState("{}");
  const [testInputError, setTestInputError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ToolTestResult | null>(null);
  const [targetAgentId, setTargetAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const [mcpForm, setMcpForm] = useState({ name: "", description: "", endpoint: "" });
  const [customForm, setCustomForm] = useState({ name: "", display_name: "", description: "", category: "Other", effect: "unknown" as ToolEffect, source_code: "" });

  function showToast(type: "success" | "error", message: string) {
    window.clearTimeout(toastTimerRef.current);
    setToast({ type, message });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }
  function apiError(reason: unknown, fallback: string) {
    showToast("error", reason instanceof Error ? reason.message : fallback);
  }
  function closeMcpEdit() {
    if (busy) return;
    setEditingSource(null);
    setMcpForm({ name: "", description: "", endpoint: "" });
  }
  function openTool(tool: ToolDefinition) {
    setSelected(tool);
    setToolModalTab("info");
    setTestInput("{}");
    setTestInputError(null);
    setTestResult(null);
  }
  function closeTool() {
    if (busy) return;
    setSelected(null);
    setToolModalTab("info");
    setTestInput("{}");
    setTestInputError(null);
    setTestResult(null);
  }
  const load = async (announce = false) => {
    setLoading(true);
    try { const [nextSources, nextTools] = await Promise.all([getToolSources(), getTools()]); setSources(nextSources); setTools(nextTools); if (announce) showToast("success", "Marketplace loaded successfully."); }
    catch (reason) { apiError(reason, "Could not load the tool library"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(true); return () => window.clearTimeout(toastTimerRef.current); }, []);

  const visibleTools = tools.filter((tool) => {
    const query = search.trim().toLowerCase();
    return (!query || [tool.display_name, tool.description, tool.source_name, tool.category].some((value) => value.toLowerCase().includes(query)))
      && (!connection || tool.connection_type === connection);
  });

  async function submitMcp(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await registerMcpSource({ ...mcpForm, owner_email: USER_PROFILE.emailId }); setDialog(null); setMcpForm({ name: "", description: "", endpoint: "" }); await load(); showToast("success", "MCP server registered successfully."); }
    catch (reason) { apiError(reason, "Could not register MCP server"); }
    finally { setBusy(false); }
  }
  async function submitMcpEdit(event: FormEvent) {
    event.preventDefault();
    if (!editingSource) return;
    setBusy(true);
    try {
      const updated = await updateMcpSource(editingSource.source_id, mcpForm);
      const sourceTools = await getToolsForSource(editingSource.source_id);
      setSources((items) => items.map((item) => item.source_id === editingSource.source_id
        ? { ...item, ...updated, tool_count: sourceTools.length, last_error: updated.test.error }
        : item));
      setTools((items) => [...items.filter((item) => item.source_id !== editingSource.source_id), ...sourceTools]);
      setEditingSource(null);
      setMcpForm({ name: "", description: "", endpoint: "" });
      if (updated.test.status === "available") showToast("success", "MCP server updated and refreshed successfully.");
      else showToast("error", updated.test.error || "MCP server was updated, but the connection test failed.");
    } catch (reason) { apiError(reason, "Could not update MCP server"); }
    finally { setBusy(false); }
  }
  async function submitCustom(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await createCustomTool({ ...customForm, owner_email: USER_PROFILE.emailId }); setDialog(null); setCustomForm({ name: "", display_name: "", description: "", category: "Other", effect: "unknown", source_code: "" }); await load(); showToast("success", "Custom tool created successfully."); }
    catch (reason) { apiError(reason, "Could not create custom tool"); }
    finally { setBusy(false); }
  }
  async function refreshSource(sourceId: string) {
    setRefreshingSourceId(sourceId);
    try {
      const test = await testToolSource(sourceId);
      const sourceTools = await getToolsForSource(sourceId);
      setSources((items) => items.map((item) => item.source_id === sourceId
        ? { ...item, status: test.status, tool_count: sourceTools.length, last_error: test.error }
        : item));
      setTools((items) => [...items.filter((item) => item.source_id !== sourceId), ...sourceTools]);
      if (test.status === "available") showToast("success", "MCP server connection refreshed successfully.");
      else showToast("error", test.error || "MCP server connection test failed.");
    } catch (reason) { apiError(reason, "Connection test failed"); }
    finally { setRefreshingSourceId(null); }
  }
  async function removeSource(source: ToolSource) {
    if (!window.confirm(`Delete MCP server "${source.name}" and deactivate all of its tools?`)) return;
    setBusy(true);
    try { await deleteToolSource(source.source_id); setSources((items) => items.filter((item) => item.source_id !== source.source_id)); setTools((items) => items.filter((item) => item.source_id !== source.source_id)); if (selectedSourceId === source.source_id) setSelectedSourceId(""); showToast("success", "MCP server deleted successfully."); }
    catch (reason) { apiError(reason, "Could not delete MCP server"); }
    finally { setBusy(false); }
  }
  async function removeTool(tool: ToolDefinition) {
    if (!window.confirm(`Delete tool "${tool.display_name}"?`)) return;
    setBusy(true);
    try { await deleteLibraryTool(tool.tool_definition_id); setTools((items) => items.filter((item) => item.tool_definition_id !== tool.tool_definition_id)); setSelected(null); showToast("success", "Tool deleted successfully."); }
    catch (reason) { apiError(reason, "Could not delete tool"); }
    finally { setBusy(false); }
  }
  async function runTest(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(testInput) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arguments must be a JSON object");
      args = parsed as Record<string, unknown>;
      setTestInputError(null);
    } catch (reason) {
      setTestInputError(reason instanceof Error ? reason.message : "Enter valid JSON arguments.");
      return;
    }
    setBusy(true); setTestResult(null);
    try {
      const result = await testLibraryTool(selected.tool_definition_id, args, USER_PROFILE.emailId);
      setTestResult(result);
      if (result.outcome === "success") showToast("success", "Tool test completed successfully.");
      else showToast("error", result.error || "Tool test failed.");
    }
    catch (reason) { apiError(reason, "Tool test failed"); }
    finally { setBusy(false); }
  }
  async function addToAgent() {
    const agent = agents.find((item) => item.agent_id === targetAgentId);
    if (!agent || !selected) return;
    if (agent.tooling.some((item) => item.tool_definition_id === selected.tool_definition_id)) { showToast("error", "This tool is already attached to that agent."); return; }
    const snapshot: AgentTool = {
      name: selected.external_name, description: selected.description, source_code: selected.source_code ?? "", enabled: true,
      connection_type: selected.connection_type, tool_definition_id: selected.tool_definition_id, source_id: selected.source_id,
      version: selected.version, category: selected.category, effect: selected.effect, effect_source: selected.effect_source,
      input_schema: selected.input_schema, approval_policy: "automatic", allowed_scope: {}, defaults: {},
    };
    setBusy(true);
    try { const updated = await updateAgent(agent.agent_id, { tooling: [...agent.tooling, snapshot] }); onUpdated(updated); setSelected(null); showToast("success", "Tool added to agent successfully."); }
    catch (reason) { apiError(reason, "Could not add tool to agent"); }
    finally { setBusy(false); }
  }

  const selectedInputFields = toolInputFields(selected?.input_schema);
  const selectedExampleInput = Object.fromEntries(selectedInputFields.map((field) => [field.name, schemaExample(field.schema)]));

  return <section className="content-page marketplace-page"><header className="content-page-header"><div><p className="eyebrow">TOOL LIBRARY</p><h1>Marketplace</h1><p>Register sources, discover tools, and test them before adding snapshots to agents.</p></div><div className="agent-header-actions">{tab === "connections" && <><label className="catalog-search mcp-search"><span className="sr-only">Search MCP servers</span><input type="search" value={mcpSearch} onChange={(event) => setMcpSearch(event.target.value)} placeholder="Search MCP servers" /></label><button type="button" className="marketplace-icon-button primary-icon header-icon-action" onClick={() => setDialog("mcp")} aria-label="Register MCP server" title="Register MCP server"><MarketplaceActionIcon name="connect" /></button></>}{tab === "tools" && <button type="button" className="marketplace-icon-button primary-icon header-icon-action" onClick={() => setDialog("custom")} aria-label="Create Python tool" title="Create Python tool"><MarketplaceActionIcon name="create" /></button>}</div></header>
    <div className={`marketplace-toolbar ${tab === "connections" ? "mcp-toolbar" : ""}`}><div className="marketplace-tabs" role="tablist">{([ ["apps","Apps"],["connections","MCP Servers"],["tools","Tool Library"] ] as const).map(([id,label]) => <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}>{label}</button>)}</div>{tab === "tools" && <div className="tool-library-toolbar-controls"><label className="catalog-search marketplace-search"><span className="sr-only">Search tools</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by business task" /></label><label className="sr-only" htmlFor="tool-connection-filter">Filter by connection</label><select id="tool-connection-filter" value={connection} onChange={(event) => setConnection(event.target.value)}><option value="">All connections</option><option value="mcp">MCP</option><option value="custom_langchain">Custom · LangChain</option></select></div>}</div>
    <div className={`marketplace-tab-surface marketplace-${tab}-surface`}>
    <div className="marketplace-tab-scroll">
    {tab === "apps" && <div className="marketplace-grid app-library-grid">{MARKETPLACE_APPS.map((app) => <article className="marketplace-card app-card" key={app.name}><div className="marketplace-icon">{app.icon}</div><div className="marketplace-card-content"><h2>{app.name}</h2><p>{app.description}</p><span className="app-category-tag">{app.category}</span></div></article>)}</div>}
    {tab === "connections" && (() => { const query = mcpSearch.trim().toLowerCase(); const allMcpSources = sources.filter((source) => source.source_type === "mcp"); const mcpSources = allMcpSources.filter((source) => !query || [source.name, source.description ?? "", source.endpoint ?? ""].some((value) => value.toLowerCase().includes(query))); const selectedSource = allMcpSources.find((source) => source.source_id === selectedSourceId); const selectedSourceTools = selectedSource ? tools.filter((tool) => tool.source_id === selectedSource.source_id) : []; return <div className="mcp-server-layout"><section className="mcp-server-panel"><header><div><span className="marketplace-category">REGISTERED SOURCES</span><h2>MCP Servers</h2></div><span>{mcpSources.length}</span></header>{loading ? <div className="mcp-loading" role="status"><i className="loading-circle" /><span>Loading MCP servers</span></div> : <div className="mcp-server-grid">{mcpSources.map((source) => <article role="button" tabIndex={0} aria-pressed={selectedSourceId === source.source_id} className={`marketplace-card catalog-card connection-card ${selectedSourceId === source.source_id ? "selected" : ""}`} onClick={() => setSelectedSourceId(source.source_id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedSourceId(source.source_id); } }} key={source.source_id}><div className="marketplace-icon">MCP</div><div className="marketplace-card-content"><div className="connection-card-heading"><h2>{source.name}</h2><AvailabilityDot status={source.status} /></div><p>{source.description || "No description provided."}</p><code>{source.endpoint}</code><p>{source.tool_count} discovered tools</p><div className="card-actions"><button type="button" className="marketplace-icon-button secondary-icon" disabled={refreshingSourceId !== null} onClick={(event) => { event.stopPropagation(); void refreshSource(source.source_id); }} aria-label={`Test and refresh ${source.name}`} title="Test & refresh">{refreshingSourceId === source.source_id ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="refresh" />}</button><button type="button" className="marketplace-icon-button secondary-icon" disabled={busy} onClick={(event) => { event.stopPropagation(); setEditingSource(source); setMcpForm({ name: source.name, description: source.description ?? "", endpoint: source.endpoint ?? "" }); }} aria-label={`Edit ${source.name}`} title="Edit"><MarketplaceActionIcon name="edit" /></button><button type="button" className="marketplace-icon-button danger-icon" disabled={busy} onClick={(event) => { event.stopPropagation(); void removeSource(source); }} aria-label={`Delete ${source.name}`} title="Delete"><MarketplaceActionIcon name="trash" /></button></div></div></article>)}{mcpSources.length === 0 && <p className="mcp-not-found">No MCP Server found</p>}</div>}</section><aside className="mcp-tools-panel" aria-live="polite">{selectedSource ? <><header><div><span className="marketplace-category">MCP TOOLS</span><h2>{selectedSource.name}</h2></div><span>{selectedSourceTools.length}</span></header>{selectedSourceTools.length ? <ul>{selectedSourceTools.map((tool) => <li key={tool.tool_definition_id}><span>{tool.display_name}</span><AvailabilityDot status={tool.status} /></li>)}</ul> : <p className="mcp-tools-empty">No tools discovered for this server.</p>}</> : <><header><div><span className="marketplace-category">DISCOVERED TOOLS</span><h2>MCP Tools</h2></div></header><p className="mcp-tools-empty">Select an MCP server to view its tools.</p></>}</aside></div>; })()}
    {tab === "tools" && <div className="marketplace-grid tool-library-grid">{visibleTools.map((tool) => { const sourceLabel = tool.connection_type === "mcp" ? tool.source_name : "Custom · LangChain"; return <button type="button" className="marketplace-card catalog-card tool-card-button" onClick={() => openTool(tool)} key={tool.tool_definition_id}><div className="marketplace-icon">{tool.connection_type === "mcp" ? "MCP" : "PY"}</div><div className="marketplace-card-content"><h2 className="tool-card-title" title={tool.display_name}>{tool.display_name}</h2><p className="tool-card-description" title={tool.description}>{tool.description}</p><div className="tool-card-footer"><span className="tool-source-tag" title={sourceLabel}>{sourceLabel}</span><div className="tool-badges"><span>{tool.effect}</span><AvailabilityDot status={tool.status} /></div></div></div></button>; })}{visibleTools.length === 0 && <p className="catalog-empty">No tools match these filters.</p>}</div>}
    </div>
    </div>
    {selected && tab === "tools" && <div className="marketplace-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTool(); }}><section className="marketplace-dialog tool-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="tool-detail-title"><div className="agent-modal-header"><h1 id="tool-detail-title">{selected.display_name}</h1><button type="button" className="marketplace-icon-button close-icon" disabled={busy} onClick={closeTool} aria-label="Close tool details" title="Close"><MarketplaceActionIcon name="close" /></button></div><div className="tool-modal-tabs" role="tablist" aria-label="Tool details"><button type="button" role="tab" aria-selected={toolModalTab === "info"} className={toolModalTab === "info" ? "active" : ""} onClick={() => setToolModalTab("info")}>Info</button><button type="button" role="tab" aria-selected={toolModalTab === "test"} className={toolModalTab === "test" ? "active" : ""} onClick={() => setToolModalTab("test")}>Test tool</button></div>{toolModalTab === "info" ? <div className="tool-modal-panel" role="tabpanel"><p>{selected.description}</p><dl className="tool-detail-list"><dt>Connection</dt><dd>{selected.connection_type === "mcp" ? "MCP" : "Custom · LangChain"}</dd><dt>Source</dt><dd>{selected.source_name}</dd><dt>Owner</dt><dd>{selected.owner_email}</dd><dt>Category</dt><dd>{selected.category}</dd><dt>Effect</dt><dd>{selected.effect} ({selected.effect_source})</dd></dl><details><summary>Developer details</summary><pre>{JSON.stringify(selected.input_schema, null, 2)}</pre></details><label className="tool-agent-select">Add to agent<select value={targetAgentId} onChange={(event) => setTargetAgentId(event.target.value)}><option value="">Select an agent</option>{agents.map((agent) => <option value={agent.agent_id} key={agent.agent_id}>{agent.agent_name}</option>)}</select></label><div className="marketplace-form-actions"><button type="button" className="marketplace-icon-button danger-icon" disabled={busy} onClick={() => void removeTool(selected)} aria-label={`Delete ${selected.display_name}`} title="Delete"><MarketplaceActionIcon name="trash" /></button><button type="button" className="marketplace-icon-button primary-icon" disabled={!targetAgentId || busy} onClick={() => void addToAgent()} aria-label={`Add ${selected.display_name} to agent`} title="Add to agent"><MarketplaceActionIcon name="user-plus" /></button></div></div> : <form className="tool-modal-panel tool-test-panel" role="tabpanel" onSubmit={runTest}><div className="tool-test-guide"><strong>How to test this tool</strong><ol><li>Review the required and optional inputs.</li><li>Load the example JSON or enter your own values.</li><li>Run the tool and inspect its response below.</li></ol></div><section className="tool-input-guide"><header><div><h2>Inputs</h2><p>{selectedInputFields.length ? `${selectedInputFields.length} declared input${selectedInputFields.length === 1 ? "" : "s"}` : "This tool has no declared inputs."}</p></div><button type="button" className="marketplace-icon-button secondary-icon" onClick={() => { setTestInput(JSON.stringify(selectedExampleInput, null, 2)); setTestInputError(null); }} aria-label="Use example JSON" title="Use example JSON"><MarketplaceActionIcon name="json" /></button></header>{selectedInputFields.length > 0 && <div className="tool-input-list">{selectedInputFields.map((field) => <article key={field.name}><div><code>{field.name}</code><span className={field.required ? "required" : "optional"}>{field.required ? "Required" : "Optional"}</span></div><strong>{schemaType(field.schema)}</strong>{typeof field.schema.description === "string" && <p>{field.schema.description}</p>}{field.schema.default !== undefined && <small>Default: {JSON.stringify(field.schema.default)}</small>}{Array.isArray(field.schema.enum) && <small>Allowed: {field.schema.enum.map((value) => String(value)).join(", ")}</small>}</article>)}</div>}</section><details className="tool-developer-options"><summary>Developer options</summary><h3>Input schema</h3><pre>{JSON.stringify(selected.input_schema, null, 2)}</pre>{selected.output_schema && <><h3>Output schema</h3><pre>{JSON.stringify(selected.output_schema, null, 2)}</pre></>}</details><label>Arguments JSON<textarea rows={10} aria-invalid={Boolean(testInputError)} value={testInput} onChange={(event) => { setTestInput(event.target.value); setTestInputError(null); }} />{testInputError && <span className="field-error" role="alert">{testInputError}</span>}</label><button className="marketplace-icon-button primary-icon" disabled={busy} aria-label="Run tool test" title="Run test">{busy ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="play" />}</button>{testResult && <div className={`test-result ${testResult.outcome}`}><strong>{testResult.outcome} · {testResult.duration_ms}ms</strong><pre>{JSON.stringify(testResult.output ?? testResult.error, null, 2)}</pre></div>}</form>}</section></div>}
    {editingSource && <div className="marketplace-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeMcpEdit(); }}><section className="marketplace-dialog"><div className="agent-modal-header"><h1>Edit MCP Server</h1><button type="button" className="marketplace-icon-button close-icon" disabled={busy} onClick={closeMcpEdit} aria-label="Close MCP server editor" title="Close"><MarketplaceActionIcon name="close" /></button></div><form className="marketplace-form" onSubmit={submitMcpEdit}><label>Name<input required value={mcpForm.name} onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })} /></label><label>Description<textarea value={mcpForm.description} onChange={(event) => setMcpForm({ ...mcpForm, description: event.target.value })} /></label><label>Streamable HTTP endpoint<input type="url" required value={mcpForm.endpoint} onChange={(event) => setMcpForm({ ...mcpForm, endpoint: event.target.value })} /></label><button className="marketplace-icon-button primary-icon form-icon-action" disabled={busy} aria-label="Save and refresh MCP server" title="Save & refresh">{busy ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="save" />}</button></form></section></div>}
    {dialog && <div className="marketplace-dialog-backdrop"><section className="marketplace-dialog"><div className="agent-modal-header"><h1>{dialog === "mcp" ? "Register MCP Server" : "Create Python Tool"}</h1><button type="button" className="marketplace-icon-button close-icon" onClick={() => setDialog(null)} aria-label="Close dialog" title="Close"><MarketplaceActionIcon name="close" /></button></div>{dialog === "mcp" ? <form className="marketplace-form" onSubmit={submitMcp}><label>Name<input required value={mcpForm.name} onChange={(e) => setMcpForm({...mcpForm,name:e.target.value})} /></label><label>Description<textarea value={mcpForm.description} onChange={(e) => setMcpForm({...mcpForm,description:e.target.value})} /></label><label>Streamable HTTP endpoint<input type="url" required value={mcpForm.endpoint} onChange={(e) => setMcpForm({...mcpForm,endpoint:e.target.value})} /></label><button className="marketplace-icon-button primary-icon form-icon-action" disabled={busy} aria-label="Register and discover MCP server" title="Register & discover">{busy ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="connect" />}</button></form> : <form className="marketplace-form" onSubmit={submitCustom}><label>Function name<input required value={customForm.name} onChange={(e) => setCustomForm({...customForm,name:e.target.value})} /></label><label>Display name<input value={customForm.display_name} onChange={(e) => setCustomForm({...customForm,display_name:e.target.value})} /></label><label>Description<textarea required value={customForm.description} onChange={(e) => setCustomForm({...customForm,description:e.target.value})} /></label><label>Category<input value={customForm.category} onChange={(e) => setCustomForm({...customForm,category:e.target.value})} /></label><label>Effect<select value={customForm.effect} onChange={(e) => setCustomForm({...customForm,effect:e.target.value as ToolEffect})}>{["read","calculate","write","delete","unknown"].map((value) => <option key={value}>{value}</option>)}</select></label><PythonEditor value={customForm.source_code} onChange={(source_code) => setCustomForm({...customForm,source_code})} /><button className="marketplace-icon-button primary-icon form-icon-action" disabled={busy} aria-label="Save custom tool" title="Save custom tool"><MarketplaceActionIcon name="save" /></button></form>}</section></div>}
    {toast && <ToastBar toast={toast} onClose={() => { window.clearTimeout(toastTimerRef.current); setToast(null); }} />}
  </section>;
}

function columnChart(title: string, categories: string[], series: Array<{ name: string; data: number[] }>, valueSuffix = ""): Highcharts.Options {
  return {
    chart: { type: "column", backgroundColor: "transparent" },
    title: { text: title, align: "left", style: { color: "#0D2B49", fontSize: "18px", fontWeight: "700" } },
    xAxis: { categories, crosshair: true, labels: { style: { color: "#5f666b" } } },
    yAxis: { min: 0, title: { text: "" }, labels: { style: { color: "#858A8E" } } },
    legend: { enabled: series.length > 1 },
    tooltip: { shared: true, valueSuffix },
    credits: { enabled: false },
    colors: ["#2A5A94", "#CA714C", "#0D2B49"],
    series: series.map((item) => ({ type: "column", name: item.name, data: item.data })),
  };
}

function AnalyticsChart({ title, categories, series, valueSuffix }: { title: string; categories: string[]; series: Array<{ name: string; data: number[] }>; valueSuffix?: string }) {
  return <article className="analytics-chart">{categories.length ? <HighchartsReact highcharts={Highcharts} options={columnChart(title, categories, series, valueSuffix)} /> : <><h2>{title}</h2><p className="analytics-empty">No priced usage is available for this chart.</p></>}</article>;
}

function AnalyticsDashboard() {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  function load() {
    setLoading(true); setLoadError("");
    getAnalytics().then(setReport).catch((reason: Error) => setLoadError(reason.message)).finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading) return <section className="content-page analytics-state" aria-live="polite"><p>Loading analytics…</p></section>;
  if (loadError) return <section className="content-page analytics-state"><div className="error-banner">{loadError}</div><button className="primary-button" onClick={load}>Retry</button></section>;
  if (!report) return null;

  const pricedModels = report.by_model.filter((row) => row.cost_usd !== null);
  const pricedAgents = report.by_agent.filter((row) => row.cost_usd !== null);
  const formatNumber = (value: number) => value.toLocaleString("en-US");
  const costLabel = report.summary.cost_usd === null ? report.summary.cost_status : `$${report.summary.cost_usd.toFixed(6)}`;

  return <section className="content-page"><header className="content-page-header"><div><p className="eyebrow">LAST {report.lookback_days} DAYS</p><h1>Analytics</h1><p>Model usage, agent activity, token consumption, and estimated OpenAI cost.</p></div><button className="secondary-button" onClick={load}>Refresh</button></header><div className="analytics-summary"><article><span>Interactions</span><strong>{formatNumber(report.summary.interaction_count)}</strong></article><article><span>Input tokens</span><strong>{formatNumber(report.summary.input_tokens)}</strong></article><article><span>Output tokens</span><strong>{formatNumber(report.summary.output_tokens)}</strong></article><article><span>Estimated cost</span><strong className={report.summary.cost_usd === null ? "cost-unavailable" : ""}>{costLabel}</strong></article></div>{report.by_model.some((row) => row.cost_usd === null) && <p className="analytics-note">Cost charts omit models without configured pricing; unavailable cost is not treated as zero.</p>}<div className="analytics-grid"><AnalyticsChart title="Cost by model" categories={pricedModels.map((row) => row.model_id)} series={[{ name: "Cost", data: pricedModels.map((row) => row.cost_usd ?? 0) }]} valueSuffix=" USD" /><AnalyticsChart title="Cost by agent" categories={pricedAgents.map((row) => row.agent_name || row.agent_id)} series={[{ name: "Cost", data: pricedAgents.map((row) => row.cost_usd ?? 0) }]} valueSuffix=" USD" /><AnalyticsChart title="Token usage by model" categories={report.by_model.map((row) => row.model_id)} series={[{ name: "Input tokens", data: report.by_model.map((row) => row.input_tokens) }, { name: "Output tokens", data: report.by_model.map((row) => row.output_tokens) }]} /><AnalyticsChart title="Interactions by model" categories={report.by_model.map((row) => row.model_id)} series={[{ name: "Interactions", data: report.by_model.map((row) => row.interaction_count) }]} /><AnalyticsChart title="Interactions by agent" categories={report.by_agent.map((row) => row.agent_name || row.agent_id)} series={[{ name: "Interactions", data: report.by_agent.map((row) => row.interaction_count) }]} /></div></section>;
}

function AgentManager({ agents, onCreated, onUpdated, onDeleted }: { agents: Agent[]; onCreated: (agent: Agent) => void; onUpdated: (agent: Agent) => void; onDeleted: (agentId: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [search, setSearch] = useState("");
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState(MODEL_OPTIONS[0].id);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [initiativeId, setInitiativeId] = useState("");
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [libraryTools, setLibraryTools] = useState<ToolDefinition[]>([]);
  const [selectedToolIndex, setSelectedToolIndex] = useState<number | null>(null);
  const [policyText, setPolicyText] = useState("");
  const [fallback, setFallback] = useState("");
  const [selectedGuardrail, setSelectedGuardrail] = useState<"topics" | "fallback">("topics");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const availableModels = editingAgent && !MODEL_OPTIONS.some((model) => model.id === editingAgent.model_id)
    ? [...MODEL_OPTIONS, { id: editingAgent.model_id, type: editingAgent.model_type, label: `${editingAgent.model_id} (${editingAgent.model_type})`, available: true }]
    : MODEL_OPTIONS;

  useEffect(() => { getTools().then(setLibraryTools).catch(() => setLibraryTools([])); }, []);

  function addLibraryTool(tool: ToolDefinition) {
    if (tools.some((item) => item.tool_definition_id === tool.tool_definition_id)) return;
    setTools((items) => [...items, {
      name: tool.external_name, description: tool.description, source_code: tool.source_code ?? "", enabled: true,
      connection_type: tool.connection_type, tool_definition_id: tool.tool_definition_id, source_id: tool.source_id,
      version: tool.version, category: tool.category, effect: tool.effect, effect_source: tool.effect_source,
      input_schema: tool.input_schema, approval_policy: "automatic", allowed_scope: {}, defaults: {},
    }]);
  }
  const selectedModel = availableModels.find((model) => model.id === modelId && model.available) ?? availableModels.find((model) => model.available) ?? availableModels[0];

  function resetForm() {
    setName(""); setDescription(""); setModelId(MODEL_OPTIONS[0].id); setSystemPrompt(""); setUserPrompt(""); setInitiativeId("");
    setTools([]); setSelectedToolIndex(null); setPolicyText(""); setFallback(""); setSelectedGuardrail("topics"); setStep(1); setError(""); setEditingAgent(null); setModelMenuOpen(false);
  }

  function openCreate() { resetForm(); setCreating(true); }
  function openEdit(agent: Agent) {
    const guardrails = agent.guardrails ?? {};
    const allowedTopics = Array.isArray(guardrails.allowed_topics) ? guardrails.allowed_topics.filter((topic): topic is string => typeof topic === "string") : [];
    const legacyPolicy = allowedTopics.length ? `Only allow requests related to these topics: ${allowedTopics.join(", ")}.` : "";
    setEditingAgent(agent); setName(agent.agent_name); setDescription(agent.description); setModelId(agent.model_id);
    setSystemPrompt(agent.system_prompts[0] ?? ""); setUserPrompt(agent.user_prompts?.[0] ?? ""); setInitiativeId(agent.initiative_id ?? ""); setTools(agent.tooling.map((tool) => ({ ...tool }))); setSelectedToolIndex(agent.tooling.length ? 0 : null);
    setPolicyText(typeof guardrails.policy_text === "string" ? guardrails.policy_text : legacyPolicy); setFallback(typeof guardrails.out_of_scope_response === "string" ? guardrails.out_of_scope_response : "");
    setStep(1); setError(""); setCreating(true);
  }

  function closeModal() {
    if (saving) return;
    setCreating(false);
    resetForm();
  }

  useEffect(() => {
    if (!creating) return undefined;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [creating, saving]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [modelMenuOpen]);

  function handleModelListKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); setModelMenuOpen(false); modelTriggerRef.current?.focus(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)'));
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (current + 1) % options.length : (current <= 0 ? options.length - 1 : current - 1);
    options[next]?.focus();
  }

  function validationError(targetStep: number) {
    if (targetStep === 1 && (!name.trim() || !description.trim())) return "Name and description are required.";
    if (targetStep === 3 && tools.some((tool) => !tool.name.trim() || !tool.description.trim() || (tool.connection_type !== "mcp" && !tool.source_code.trim()))) return "Complete or remove each tool before continuing.";
    return "";
  }

  function next() {
    const message = validationError(step);
    if (message) { setError(message); return; }
    setError(""); setStep((value) => Math.min(6, value + 1));
  }

  function goToStep(nextStep: number) {
    if (saving) return;
    setError(""); setModelMenuOpen(false); setStep(nextStep);
  }
  function updateTool(index: number, field: keyof AgentTool, value: string | boolean) {
    setTools((items) => items.map((tool, itemIndex) => itemIndex === index ? { ...tool, [field]: value } : tool));
  }

  function addTool() {
    setTools((items) => { setSelectedToolIndex(items.length); return [...items, { name: "", description: "", source_code: "", enabled: true }]; });
  }

  function removeSelectedTool() {
    if (selectedToolIndex === null) return;
    setTools((items) => {
      const next = items.filter((_, index) => index !== selectedToolIndex);
      setSelectedToolIndex(next.length ? Math.min(selectedToolIndex, next.length - 1) : null);
      return next;
    });
  }
  async function save() {
    const detailsError = validationError(1);
    if (detailsError) { setStep(1); setError(detailsError); return; }
    const toolsError = validationError(3);
    if (toolsError) { setStep(3); setError(toolsError); return; }
    setSaving(true); setError("");
    const guardrails: Record<string, unknown> = editingAgent ? { ...editingAgent.guardrails } : {};
    delete guardrails.allowed_topics;
    if (policyText.trim()) guardrails.policy_text = policyText.trim(); else delete guardrails.policy_text;
    if (fallback.trim()) guardrails.out_of_scope_response = fallback.trim(); else delete guardrails.out_of_scope_response;
    const updatePayload: AgentUpdate = {
      agent_name: name.trim(), description: description.trim(), initiative_id: initiativeId.trim() || null, model_id: selectedModel.id,
      model_type: selectedModel.type, system_prompts: systemPrompt.trim() ? [systemPrompt.trim()] : [], user_prompts: userPrompt.trim() ? [userPrompt.trim()] : [], tooling: tools, guardrails,
    };
    try {
      if (editingAgent) {
        onUpdated(await updateAgent(editingAgent.agent_id, updatePayload));
        setCreating(false); resetForm();
      } else {
        const createPayload: AgentCreate = { ...updatePayload as Omit<Agent, "agent_id">, owner_email: USER_PROFILE.emailId, created_by: USER_PROFILE.emailId, shared_with: [] };
        onCreated(await createAgent(createPayload));
      }
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : editingAgent ? "Could not update agent." : "Could not create agent."); }
    finally { setSaving(false); }
  }

  async function removeAgent(agent: Agent) {
    if (!window.confirm(`Delete agent "${agent.agent_name}"?`)) return;
    setSaving(true); setError("");
    try { await deleteAgent(agent.agent_id); onDeleted(agent.agent_id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete agent."); }
    finally { setSaving(false); }
  }

  const agentQuery = search.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter((agent) => !agentQuery || [agent.agent_name, agent.description, agent.model_id].some((value) => value.toLocaleLowerCase().includes(agentQuery)))
    .sort((left, right) => left.agent_name.localeCompare(right.agent_name, undefined, { sensitivity: "base" }));
  const selectedTool = selectedToolIndex === null ? undefined : tools[selectedToolIndex];

  return <div className="agents-page"><div className="agents-page-header"><div><p className="eyebrow">AGENT MANAGEMENT</p><h1>Agents</h1><p>Create and manage the AI agents available in chat.</p></div><div className="agent-header-actions"><label className="catalog-search agent-search"><span className="sr-only">Search agents</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents" /></label><button className="primary-button" onClick={openCreate}>Create agent</button></div></div><div className="agent-grid">{visibleAgents.map((agent) => <article className="agent-card" key={agent.agent_id}><div className="agent-card-heading"><h2>{agent.agent_name}</h2><div className="card-actions"><button type="button" className="text-button" onClick={() => openEdit(agent)}>Edit</button><button type="button" className="danger-text-button" disabled={saving} onClick={() => void removeAgent(agent)}>Delete</button></div></div><p>{agent.description || "No description provided."}</p><small>{agent.model_id}</small></article>)}{visibleAgents.length === 0 && <p className="catalog-empty">No agents match “{search.trim()}”.</p>}</div>{creating && <div className="agent-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}><section className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="create-agent-title"><div className="agent-modal-header"><div><p className="eyebrow">{editingAgent ? "EDIT AGENT" : "CREATE AGENT"}</p><h1 id="create-agent-title">{editingAgent ? `Edit ${editingAgent.agent_name}` : "New agent"}</h1></div><button className="modal-close" type="button" onClick={closeModal} disabled={saving} aria-label={editingAgent ? "Close edit agent dialog" : "Close new agent dialog"}>×</button></div><div className="wizard-steps" aria-label={editingAgent ? "Editing progress" : "Creation progress"}>{["Details", "Prompts", "Tools", "Guardrails", "Sharing", "Review"].map((label, index) => <button type="button" className={step === index + 1 ? "active" : step > index + 1 ? "complete" : ""} aria-current={step === index + 1 ? "step" : undefined} disabled={saving} onClick={() => goToStep(index + 1)} key={label}>{index + 1}. {label}</button>)}</div><div className="agent-wizard">
    {step === 1 && <div className="wizard-fields compact-step"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label><label>Initiative ID<input value={initiativeId} onChange={(event) => setInitiativeId(event.target.value)} placeholder="Optional initiative identifier" /></label><div className="model-picker" ref={modelPickerRef}><span className="model-picker-label">Model</span><button ref={modelTriggerRef} type="button" className="model-picker-trigger" aria-haspopup="listbox" aria-expanded={modelMenuOpen} onClick={() => { const opening = !modelMenuOpen; setModelMenuOpen(opening); if (opening) requestAnimationFrame(() => modelPickerRef.current?.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')?.focus()); }} onKeyDown={(event) => { if (event.key === "Escape") { setModelMenuOpen(false); return; } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setModelMenuOpen(true); requestAnimationFrame(() => modelPickerRef.current?.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')?.focus()); } }}>{selectedModel.label}<span aria-hidden="true">⌄</span></button>{modelMenuOpen && <div className="model-picker-list" role="listbox" aria-label="Model" onKeyDown={handleModelListKey}>{availableModels.map((model) => <button type="button" role="option" aria-selected={model.available && modelId === model.id} key={model.id} disabled={!model.available} className={model.available ? "" : "unavailable"} onClick={() => { setModelId(model.id); setModelMenuOpen(false); modelTriggerRef.current?.focus(); }}><span>{model.label}</span>{!model.available && <small>Coming soon</small>}</button>)}</div>}</div></div>}
    {step === 2 && <div className="wizard-fields compact-step"><MarkdownPromptEditor label="System prompt" value={systemPrompt} onChange={setSystemPrompt} placeholder="Write system instructions using Markdown" /><MarkdownPromptEditor label="User prompt" value={userPrompt} onChange={setUserPrompt} placeholder="Write a reusable user prompt using Markdown" /></div>}
    {step === 3 && <section className="agent-library-picker"><div><h2>Tool Library</h2><p>Select individual tools. A snapshot is copied into this agent.</p></div><div>{libraryTools.filter((tool) => tool.status === "available").map((tool) => <button type="button" disabled={tools.some((item) => item.tool_definition_id === tool.tool_definition_id)} onClick={() => addLibraryTool(tool)} key={tool.tool_definition_id}><span>{tool.display_name}</span><small>{tool.connection_type === "mcp" ? "MCP" : "Custom · LangChain"} · {tool.effect}</small></button>)}</div></section>}
    {step === 3 && <div className="master-detail"><aside className="master-list"><div className="master-list-heading"><div><h2>Agent tools</h2><p>Configure copied tools.</p></div><button type="button" className="secondary-button" onClick={addTool}>New inline tool</button></div>{tools.length ? tools.map((tool, index) => <button type="button" className={selectedToolIndex === index ? "active" : ""} aria-pressed={selectedToolIndex === index} onClick={() => setSelectedToolIndex(index)} key={index}><span>{tool.name.trim() || `Untitled tool ${index + 1}`}</span><small>{tool.connection_type === "mcp" ? "MCP · saved only" : tool.enabled ? "Enabled" : "Disabled"}</small></button>) : <p className="master-empty">No tools added.</p>}</aside><section className="detail-panel">{selectedTool && selectedToolIndex !== null ? <div className="tool-editor"><button type="button" className="remove-button" onClick={removeSelectedTool}>Remove tool</button><label>Name<input value={selectedTool.name} onChange={(event) => updateTool(selectedToolIndex, "name", event.target.value)} /></label><label>Description<input value={selectedTool.description} onChange={(event) => updateTool(selectedToolIndex, "description", event.target.value)} /></label>{selectedTool.connection_type !== "mcp" && <PythonEditor value={selectedTool.source_code} onChange={(value) => updateTool(selectedToolIndex, "source_code", value)} />}<label>Approval policy<select value={selectedTool.approval_policy ?? "automatic"} onChange={(event) => updateTool(selectedToolIndex, "approval_policy", event.target.value)}><option value="automatic">Automatic</option><option value="ask">Ask (stored; not executed in v1)</option><option value="disabled">Disabled</option></select></label><label className="checkbox-label"><input type="checkbox" checked={selectedTool.enabled} onChange={(event) => updateTool(selectedToolIndex, "enabled", event.target.checked)} /> Enabled</label></div> : <p className="detail-empty">Select a tool or add one from the library.</p>}</section></div>}
    {step === 4 && <div className="master-detail"><aside className="master-list guardrail-list"><div className="master-list-heading"><div><h2>Guardrails</h2><p>Select a guardrail to configure.</p></div></div><button type="button" className={selectedGuardrail === "topics" ? "active" : ""} aria-pressed={selectedGuardrail === "topics"} onClick={() => setSelectedGuardrail("topics")}>Guardrail policy</button><button type="button" className={selectedGuardrail === "fallback" ? "active" : ""} aria-pressed={selectedGuardrail === "fallback"} onClick={() => setSelectedGuardrail("fallback")}>Out-of-scope response</button></aside><section className="detail-panel guardrail-detail">{selectedGuardrail === "topics" ? <label>Guardrail policy<textarea value={policyText} onChange={(event) => setPolicyText(event.target.value)} rows={9} placeholder="Describe which requests this agent may handle and any restrictions it must enforce." /><small>The model evaluates every user message against this policy before tools or normal chat run.</small></label> : <label>Out-of-scope response<textarea value={fallback} onChange={(event) => setFallback(event.target.value)} rows={7} placeholder="Response returned when the guardrail blocks a request" /></label>}</section></div>}
    {step === 5 && <div className="wizard-fields compact-step sharing-step"><div><h2>Sharing</h2><p>Agent sharing will be available in a future release.</p></div><label>Email ID<input type="email" disabled placeholder="person@example.com" /></label><span className="coming-soon-note">Coming soon — sharing is currently disabled.</span></div>}
    {step === 6 && <div className="review"><h2>{editingAgent ? "Review your changes" : "Review your agent"}</h2><dl><dt>Name</dt><dd>{name}</dd><dt>Description</dt><dd>{description}</dd><dt>Initiative ID</dt><dd>{initiativeId || "None"}</dd><dt>Model</dt><dd>{selectedModel.label}</dd><dt>System prompt</dt><dd className="review-markdown">{systemPrompt ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{systemPrompt}</ReactMarkdown> : "None"}</dd><dt>User prompt</dt><dd className="review-markdown">{userPrompt ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{userPrompt}</ReactMarkdown> : "None"}</dd><dt>Tools</dt><dd>{tools.length || "None"}</dd><dt>Guardrail policy</dt><dd>{policyText || "None"}</dd><dt>Fallback</dt><dd>{fallback || "None"}</dd><dt>Sharing</dt><dd>Disabled</dd></dl></div>}
    {error && <div className="error-banner">{error}</div>}<div className="wizard-actions"><button className="secondary-button" onClick={() => step === 1 ? closeModal() : setStep((value) => value - 1)} disabled={saving}>{step === 1 ? "Cancel" : "Back"}</button>{step < 6 ? <button className="primary-button" onClick={next}>Continue</button> : <button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? editingAgent ? "Saving…" : "Creating…" : editingAgent ? "Save changes" : "Create agent"}</button>}</div>
  </div></section></div>}</div>;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const conversationRoute = matchPath("/conversations/:sessionId", location.pathname);
  const routeSessionId = conversationRoute?.params.sessionId;
  const view = location.pathname === "/agents" ? "agents" : location.pathname === "/marketplace" ? "marketplace" : location.pathname === "/analytics" ? "analytics" : "chat";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationLoadingId, setConversationLoadingId] = useState<string>();
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const conversationLoadControllerRef = useRef<AbortController | null>(null);
  const routeDraftRef = useRef<Conversation | null>(null);
  const active = conversations.find((conversation) => conversation.id === activeId);
  const localDraft = conversations.find((conversation) => !conversation.sessionId && !conversation.messages.length);
  const savedConversations = conversations.filter((conversation) => conversation.id !== localDraft?.id).slice(0, 5);
  const sidebarConversations = localDraft ? [localDraft, ...savedConversations] : savedConversations;
  const selectedAgentName = agents.find((agent) => agent.agent_id === selectedAgent)?.agent_name ?? "Choose an agent";
  const conversationTitle = active?.messages.find((message) => message.role === "user")?.content ?? active?.title ?? "New conversation";

  useEffect(() => {
    getAgents().then((items) => {
      setAgents(items);
      setSelectedAgent(items[0]?.agent_id ?? "");
    }).catch((reason: Error) => setError(reason.message));
  }, []);

  useEffect(() => {
    getConversations(USER_PROFILE.emailId).then((items) => {
      const saved = items.map(conversationFromSummary);
      setConversations((current) => {
        const draft = current.find((conversation) => !conversation.sessionId && !conversation.messages.length);
        return draft ? [draft, ...saved] : saved;
      });
    }).catch((reason: Error) => setError(reason.message)).finally(() => setConversationsLoading(false));
  }, []);

  useEffect(() => {
    if (conversationsLoading || view !== "chat") return;
    if (routeSessionId) {
      const existing = conversations.find((conversation) => conversation.sessionId === routeSessionId);
      if (existing) {
        setActiveId(existing.id);
        if (existing.agentId) setSelectedAgent(existing.agentId);
        void loadConversation(existing);
        return;
      }
      const placeholder: Conversation = {
        id: `saved:${routeSessionId}`,
        sessionId: routeSessionId,
        historyLoaded: false,
        title: "Loading conversation",
        messages: [],
      };
      setConversations((items) => items.some((conversation) => conversation.sessionId === routeSessionId) ? items : [placeholder, ...items]);
      setActiveId(placeholder.id);
      void loadConversation(placeholder);
      return;
    }
    const draft = conversations.find((conversation) => !conversation.sessionId && !conversation.messages.length);
    if (draft) {
      setActiveId(draft.id);
      return;
    }
    const conversation = routeDraftRef.current ?? createConversation(selectedAgent);
    routeDraftRef.current = conversation;
    setConversations((items) => items.some((item) => item.id === conversation.id) ? items : [conversation, ...items]);
    setActiveId(conversation.id);
  }, [routeSessionId, conversationsLoading, view]);

  useEffect(() => {
    requestAnimationFrame(() => chatBodyRef.current?.scrollTo({
      top: chatBodyRef.current.scrollHeight,
      behavior: "smooth",
    }));
  }, [activeId, conversations]);

  function resizeTextarea(element = textareaRef.current) {
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 48), 160)}px`;
  }

  function updatePrompt(value: string) {
    setPrompt(value);
    requestAnimationFrame(() => resizeTextarea());
  }

  function newChat() {
    conversationLoadControllerRef.current?.abort();
    setConversationLoadingId(undefined);
    const draft = conversations.find((conversation) => !conversation.sessionId && !conversation.messages.length);
    if (draft) {
      routeDraftRef.current = draft;
      setActiveId(draft.id);
      if (draft.agentId) setSelectedAgent(draft.agentId);
      navigate("/chat");
      setPrompt("");
      setError("");
      requestAnimationFrame(() => resizeTextarea());
      return;
    }
    const conversation = createConversation(selectedAgent);
    routeDraftRef.current = conversation;
    setConversations((items) => [conversation, ...items]);
    setActiveId(conversation.id);
    navigate("/chat");
    setPrompt("");
    requestAnimationFrame(() => resizeTextarea());
    setError("");
  }

  function startNewConversation(agentId: string) {
    const conversation = createConversation(agentId);
    routeDraftRef.current = conversation;
    setConversations((items) => [conversation, ...items]);
    setActiveId(conversation.id);
    navigate("/chat");
    return conversation;
  }

  async function sendPrompt(text: string, agentId: string, suppliedConversation?: Conversation) {
    if (!text || !agentId || streaming) return;
    let conversation = suppliedConversation ?? active;
    if (!conversation || (conversation.agentId && conversation.agentId !== agentId && (Boolean(conversation.sessionId) || conversation.messages.length > 0))) {
      conversation = startNewConversation(agentId);
    }
    const conversationId = conversation.id;
    setConversations((items) => items.map((item) => item.id === conversationId ? {
      ...item,
      agentId,
      title: item.sessionId || item.messages.length ? item.title : text.slice(0, 34),
      messages: [...item.messages, { role: "user", content: text, createdAt: new Date().toISOString() }],
      executionEvents: [],
      executionAgentName: agents.find((agent) => agent.agent_id === agentId)?.agent_name ?? "Agent",
      executionStatus: "running",
    } : item));
    setPrompt("");
    setError("");
    setStreaming(true);
    let finalResult: ChatEvent["response"];
    try {
      await streamChat({ agent_id: agentId, user_id: USER_PROFILE.emailId, user_prompt: text, session_id: conversation.sessionId }, (event) => {
        setConversations((items) => items.map((item) => item.id === conversationId ? {
          ...item,
          executionEvents: [...(item.executionEvents ?? []), event],
          executionStatus: event.type === "error" ? "failed" : event.type === "complete" ? "completed" : item.executionStatus,
        } : item));
        if (event.type === "final" && event.response) {
          finalResult = event.response;
          return;
        }
        if (event.type === "error") setError(String(event.detail ?? "The chat request failed."));
      });
      if (finalResult) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 450));
        const result = finalResult;
        setConversations((items) => items.map((item) => item.id === conversationId ? {
          ...item, agentId, sessionId: result.session_id, chatSequenceId: result.chat_sequence_id,
          executionEvents: undefined, executionAgentName: undefined, executionStatus: undefined,
          messages: [...item.messages, { role: "assistant", content: String(result.response.content), createdAt: new Date().toISOString(), response: result.response, executionEvents: item.executionEvents ?? [], executionAgentName: item.executionAgentName, executionStatus: "completed" }],
        } : item));
        if (!conversation.sessionId) {
          if (routeDraftRef.current?.id === conversationId) routeDraftRef.current = null;
          navigate(conversationPath(result.session_id), { replace: true });
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The chat request failed.");
      setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, executionStatus: "failed" } : item));
    } finally {
      setStreaming(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void sendPrompt(prompt.trim(), selectedAgent);
  }

  function selectAgent(agentId: string) {
    const agentChanged = agentId !== selectedAgent;
    setSelectedAgent(agentId);
    setAgentPickerOpen(false);
    const text = prompt.trim();
    const conversation = agentChanged && active && (active.sessionId || active.messages.length) ? startNewConversation(agentId) : active;
    if (conversation && !conversation.sessionId && !conversation.messages.length) {
      setConversations((items) => items.map((item) => item.id === conversation.id ? { ...item, agentId } : item));
    }
    if (text) void sendPrompt(text, agentId, conversation);
  }

  async function loadConversation(conversation: Conversation) {
    conversationLoadControllerRef.current?.abort();
    if (!conversation.sessionId || conversation.historyLoaded) {
      conversationLoadControllerRef.current = null;
      setConversationLoadingId(undefined);
      return;
    }
    const controller = new AbortController();
    conversationLoadControllerRef.current = controller;
    setConversationLoadingId(conversation.id);
    setError("");
    try {
      const detail = await getConversation(conversation.sessionId, USER_PROFILE.emailId, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedAgent(detail.agent_id);
      setConversations((items) => items.map((item) => item.id === conversation.id ? {
        ...item,
        agentId: detail.agent_id,
        chatSequenceId: detail.interaction_count,
        historyLoaded: true,
        title: detail.title || item.title,
        messages: detail.messages.map((message) => ({
          role: message.role,
          content: message.content,
          createdAt: message.created_at,
          response: message.role === "assistant" ? message.response ?? { type: "markdown", content: message.content } : undefined,
        })),
      } : item));
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "Could not load conversation");
      }
    } finally {
      if (conversationLoadControllerRef.current === controller) {
        conversationLoadControllerRef.current = null;
        setConversationLoadingId(undefined);
      }
    }
  }

  function openConversation(conversation: Conversation) {
    setActiveId(conversation.id);
    if (conversation.agentId) setSelectedAgent(conversation.agentId);
    navigate(conversation.sessionId ? conversationPath(conversation.sessionId) : "/chat");
  }

  function agentCreated(agent: Agent) {
    setAgents((items) => [agent, ...items]);
    setSelectedAgent(agent.agent_id);
    const conversation = createConversation(agent.agent_id);
    routeDraftRef.current = conversation;
    setConversations((items) => [conversation, ...items]);
    setActiveId(conversation.id);
    navigate("/chat");
    setPrompt("");
  }

  function agentUpdated(agent: Agent) {
    setAgents((items) => items.map((item) => item.agent_id === agent.agent_id ? agent : item));
  }

  function agentDeleted(agentId: string) {
    const remaining = agents.filter((agent) => agent.agent_id !== agentId);
    setAgents(remaining);
    if (selectedAgent === agentId) setSelectedAgent(remaining[0]?.agent_id ?? "");
  }

  const conversationAgentName = agents.find((agent) => agent.agent_id === active?.agentId)?.agent_name ?? selectedAgentName;
  const activeConversationLoading = conversationLoadingId === active?.id;
  const activeHistoryPending = Boolean(active?.sessionId && !active.historyLoaded);
  const headerAgent = agents.find((agent) => agent.agent_id === active?.agentId) ?? (!active?.sessionId ? agents.find((agent) => agent.agent_id === selectedAgent) : undefined);
  const conversationModelId = headerAgent?.model_id ?? (activeHistoryPending || activeConversationLoading ? "Loading model…" : "No model selected");

  return <main className="app-shell">
    <aside className={sidebarExpanded ? "sidebar expanded" : "sidebar"} onPointerEnter={() => setSidebarExpanded(true)} onPointerLeave={() => setSidebarExpanded(false)} onPointerUp={(event) => { if ((event.target as Element).closest("button,a")) setSidebarExpanded(false); }} onFocusCapture={() => setSidebarExpanded(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSidebarExpanded(false); }}>
      <div className="brand"><span className="brand-monogram" title="Deln Bank" aria-label="Deln Bank">A</span><span className="brand-name">AI Harness</span></div>
      <button className="new-chat" onClick={newChat} aria-label="New chat" title="New chat"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span className="sidebar-label">New chat</span></button>
      <nav className="nav-links"><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/agents" title="Agents"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6M12 4V2M7 7h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Z" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /><path d="M9 17h6" /></svg><span className="sidebar-label">Agents</span></NavLink><button className="nav-item disabled" type="button" disabled title="Initiatives — Coming soon" aria-label="Initiatives — Coming soon"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></svg><span className="sidebar-label">Initiatives</span></button><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/marketplace" title="Marketplace"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16l-1 11H5L4 9Z" /><path d="M8 9V6a4 4 0 0 1 8 0v3" /></svg><span className="sidebar-label">Marketplace</span></NavLink><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/analytics" title="Analytics"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16" /><path d="m7 15 4-4 3 2 5-6" /></svg><span className="sidebar-label">Analytics</span></NavLink></nav>
      <section className="conversation-history" aria-label="Conversations">
        <div className="conversation-heading"><div className="conversation-heading-title"><svg className="conversation-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14A2.5 2.5 0 0 1 21.5 8v7A2.5 2.5 0 0 1 19 17.5H10l-4.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2-2.5Z" /><path d="M8 11h8M8 14h5" /></svg><span className="section-label sidebar-label">Conversations</span></div><span className="section-divider" aria-hidden="true" /></div>
        <div className="history">{conversationsLoading ? <div className="conversation-loading" role="status" aria-label="Loading conversations"><span /><span /><span /></div> : sidebarConversations.map((conversation) => <button className={view === "chat" && conversation.id === activeId ? "history-item active" : "history-item"} key={conversation.id} onClick={() => openConversation(conversation)} title={conversation.title} aria-label={conversation.title}><svg className="history-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14A2.5 2.5 0 0 1 21.5 8v7A2.5 2.5 0 0 1 19 17.5H10l-4.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2-2.5Z" /></svg><span className="history-label">{conversation.title}</span></button>)}</div>
      </section>
      <div className="profile" title={USER_PROFILE.emailId}><span className="avatar" title={USER_PROFILE.name}>{USER_PROFILE.name.charAt(0).toUpperCase()}</span><span className="profile-name">{USER_PROFILE.name}</span></div>
    </aside>
    <section className={view === "chat" ? "workspace" : "workspace content-workspace"}>
      <Routes><Route path="/" element={<Navigate to="/chat" replace />} /><Route path="/chat" element={null} /><Route path="/conversations/:sessionId" element={null} /><Route path="/agents" element={null} /><Route path="/marketplace" element={null} /><Route path="/analytics" element={null} /><Route path="*" element={<Navigate to="/chat" replace />} /></Routes>
      {view === "agents" ? <AgentManager agents={agents} onCreated={agentCreated} onUpdated={agentUpdated} onDeleted={agentDeleted} /> : view === "marketplace" ? <ToolLibraryMarketplace agents={agents} onUpdated={agentUpdated} /> : view === "analytics" ? <AnalyticsDashboard /> : <>
      <header className="topbar"><span className="conversation-model" title={conversationModelId}>{conversationModelId}</span><span className="topbar-divider" aria-hidden="true" /><span className="conversation-title" title={conversationTitle} aria-label={conversationTitle}>{conversationTitle}</span></header>
      <div ref={chatBodyRef} className={active?.messages.length || activeConversationLoading ? "chat-body transcript" : "chat-body welcome"}>
        {activeConversationLoading && <div className="transcript-loading" role="status" aria-label="Loading conversation"><span /><span /><span /><p>Loading conversation</p></div>}
        {!activeConversationLoading && !active?.messages.length && <div className="welcome-content"><p className="eyebrow">AI HARNESS</p><h1>Where should we start?</h1><p>Ask your configured AI agent anything.</p><div className="suggestions"><button onClick={() => setPrompt("Analyse my portfolio allocation")}>Analyse my portfolio allocation</button><button onClick={() => setPrompt("Get the latest price for AAPL")}>Get a current stock price</button><button onClick={() => setPrompt("Calculate my net worth with stock holdings")}>Calculate my net worth with stock holdings</button></div></div>}
        {active?.messages.map((message, index) => <article key={`${message.role}-${index}`} className={`message ${message.role}`}><div className="message-card"><div className="message-meta">{message.role === "assistant" ? <><span className="agent-avatar" aria-hidden="true">{agentInitials(conversationAgentName)}</span><span className="agent-status" title="Available" aria-label="Available" /><span>{conversationAgentName}</span></> : <span className="user-avatar">You</span>}</div>{message.response ? <MessageContent message={message.response} /> : <div className="message-text">{message.content}</div>}<time className="message-time">{formatMessageTime(message.createdAt) ?? "Just now"}</time>{message.role === "assistant" && message.response && <MessageActions message={message.response} executionEvents={message.executionEvents} executionAgentName={message.executionAgentName} executionStatus={message.executionStatus} />}</div></article>)}
        {(active?.executionEvents?.length ?? 0) > 0 && <LiveExecutionTrace events={active?.executionEvents ?? []} agentName={active?.executionAgentName ?? conversationAgentName} status={active?.executionStatus ?? "running"} />}
        {error && <div className="error-banner">{error}</div>}
      </div>
      <form className="composer-wrap" onSubmit={submit}><div className="composer"><div className="agent-picker-wrap"><button type="button" className="icon-button" aria-label="Choose agent" aria-expanded={agentPickerOpen} onClick={() => setAgentPickerOpen((open) => !open)}>+</button>{agentPickerOpen && <div className="agent-picker" role="listbox" aria-label="Choose an agent">{agents.map((agent) => <button type="button" key={agent.agent_id} className={agent.agent_id === selectedAgent ? "agent-option active" : "agent-option"} onClick={() => selectAgent(agent.agent_id)} role="option" aria-selected={agent.agent_id === selectedAgent}><span>{agent.agent_name}</span><small>{agent.model_id}</small></button>)}</div>}</div><span className="selected-agent" aria-live="polite" title={selectedAgentName}>{selectedAgentName}</span><textarea ref={textareaRef} value={prompt} onChange={(event) => updatePrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(event); } }} placeholder={activeConversationLoading ? "Loading conversation..." : activeHistoryPending ? "Select the conversation again to retry" : selectedAgent ? `Ask ${selectedAgentName} anything...` : "Select an agent to begin"} disabled={!selectedAgent || streaming || activeHistoryPending} rows={1} /><button type="submit" className="send-button" aria-label="Send message" disabled={!prompt.trim() || !selectedAgent || streaming || activeHistoryPending}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V6m0 0-5 5m5-5 5 5" /></svg></button></div><p>AI Harness may make mistakes. Check important information.</p></form>
      </>}
    </section>
  </main>;
}
