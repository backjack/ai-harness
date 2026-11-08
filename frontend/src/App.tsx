import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { matchPath, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { createAgent, createCustomTool, deleteAgent, deleteLibraryTool, deleteToolSource, getAgents, getAnalytics, getConversation, getConversations, getTools, getToolsForSource, getToolSources, registerMcpSource, streamChat, testInlineTool, testLibraryTool, testToolSource, updateAgent, updateMcpSource } from "./api";
import type { Agent, AgentCreate, AgentGuardrails, AgentTool, AgentUpdate, AnalyticsReport, ChartContent, ChatEvent, ChatMessage, Conversation, ConversationSummary, InlineToolTestResult, ToolDefinition, ToolEffect, ToolSource, ToolTestResult } from "./types";
import InitiativeManagement from "./initiatives/InitiativeManagement";
import { useAuth } from "./auth";

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

type MarketplaceActionIconName = "connect" | "create" | "refresh" | "edit" | "trash" | "save" | "user-plus" | "play" | "json" | "close" | "plus" | "check" | "arrow-left" | "arrow-right";

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
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    "arrow-left": <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>,
    "arrow-right": <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  };
  return <svg className="marketplace-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function WizardStepIcon({ name }: { name: "details" | "prompts" | "tools" | "guardrails" | "review" }) {
  switch (name) {
    case "details":
      return (
        <svg className="wizard-step-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <line x1="10" y1="9" x2="8" y2="9" />
        </svg>
      );
    case "prompts":
      return (
        <svg className="wizard-step-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="13" x2="14" y2="13" />
        </svg>
      );
    case "tools":
      return (
        <svg className="wizard-step-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "guardrails":
      return (
        <svg className="wizard-step-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case "review":
      return (
        <svg className="wizard-step-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
  }
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

function MarkdownPromptEditor({ label, value, onChange, placeholder, readOnly = false }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; readOnly?: boolean }) {
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

  return <section className={`markdown-editor ${readOnly ? "read-only" : ""}`}><div className="editor-heading"><strong>{label}</strong><div role="group" aria-label={`${label} mode`}>{!readOnly && <button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>Edit</button>}<button type="button" className={preview || readOnly ? "active" : ""} onClick={() => setPreview(true)}>Preview</button></div></div>{preview || readOnly ? <div className="markdown-preview">{value.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown> : <p>Nothing to preview.</p>}</div> : <><div className="markdown-toolbar" role="toolbar" aria-label={`${label} formatting`}><button type="button" title="Heading" onClick={() => prefixLines("## ")}>H</button><button type="button" title="Bold" onClick={() => replaceSelection("**", "**", "bold text")}><strong>B</strong></button><button type="button" title="Italic" onClick={() => replaceSelection("_", "_", "italic text")}><em>I</em></button><button type="button" title="Bulleted list" onClick={() => prefixLines("- ")}>• List</button><button type="button" title="Numbered list" onClick={() => prefixLines("1. ")}>1. List</button><button type="button" title="Task list" onClick={() => prefixLines("- [ ] ")}>☐ Task</button><button type="button" title="Link" onClick={() => replaceSelection("[", "](https://example.com)", "link text")}>Link</button><button type="button" title="Inline code" onClick={() => replaceSelection("`", "`", "code")}>Code</button><button type="button" title="Code block" onClick={() => replaceSelection("```\n", "\n```", "code")}>Block</button></div><textarea ref={textareaRef} value={value} onChange={(event) => onChange(event.target.value)} rows={9} placeholder={placeholder} /></>}</section>;
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

function AssistantTypingIndicator({ agentName }: { agentName: string }) {
  return <article className="message assistant typing-message" role="status" aria-label={`${agentName} is preparing a response`}>
    <div className="message-card">
      <div className="message-meta"><span className="agent-avatar" aria-hidden="true">{agentInitials(agentName)}</span><span className="agent-status" title="Available" aria-label="Available" /><span>{agentName}</span></div>
      <div className="typing-bubble" aria-hidden="true"><span /><span /><span /></div>
    </div>
  </article>;
}

function agentInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "AI";
}

type ModelOption = { id: string; type: Agent["model_type"]; label: string; available: boolean };
const MODEL_OPTIONS: ModelOption[] = [
  { id: "gpt-5.4-mini", type: "openai", label: "GPT-5.4 mini (OpenAI)", available: true },
  { id: "gpt-4.1-mini", type: "openai", label: "GPT-4.1 mini (OpenAI, legacy)", available: true },
  { id: "llama3.2:3b", type: "ollama", label: "Llama 3.2 3B (Ollama)", available: false },
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
  useEffect(() => {
    const mcpSources = sources.filter((source) => source.source_type === "mcp");
    if (mcpSources.length === 0) {
      if (selectedSourceId) setSelectedSourceId("");
      return;
    }
    if (mcpSources.some((source) => source.source_id === selectedSourceId)) return;

    const populatedSourceIds = new Set(tools.map((tool) => tool.source_id));
    const preferredSource = mcpSources.find((source) => populatedSourceIds.has(source.source_id)) ?? mcpSources[0];
    setSelectedSourceId(preferredSource.source_id);
  }, [sources, tools, selectedSourceId]);

  const visibleTools = tools.filter((tool) => {
    const query = search.trim().toLowerCase();
    return (!query || [tool.display_name, tool.description, tool.source_name, tool.category].some((value) => value.toLowerCase().includes(query)))
      && (!connection || tool.connection_type === connection);
  });

  async function submitMcp(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await registerMcpSource(mcpForm); setDialog(null); setMcpForm({ name: "", description: "", endpoint: "" }); await load(); showToast("success", "MCP server registered successfully."); }
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
    try { await createCustomTool(customForm); setDialog(null); setCustomForm({ name: "", display_name: "", description: "", category: "Other", effect: "unknown", source_code: "" }); await load(); showToast("success", "Custom tool created successfully."); }
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
      const result = await testLibraryTool(selected.tool_definition_id, args);
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
    {selected && tab === "tools" && <div className="marketplace-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTool(); }}><section className={`marketplace-dialog tool-detail-dialog ${selected.connection_type === "custom_langchain" ? "custom-tool-detail-dialog" : ""}`} role="dialog" aria-modal="true" aria-labelledby="tool-detail-title"><div className="agent-modal-header"><h1 id="tool-detail-title">{selected.display_name}</h1><button type="button" className="marketplace-icon-button close-icon" disabled={busy} onClick={closeTool} aria-label="Close tool details" title="Close"><MarketplaceActionIcon name="close" /></button></div><div className="tool-modal-tabs" role="tablist" aria-label="Tool details"><button type="button" role="tab" aria-selected={toolModalTab === "info"} className={toolModalTab === "info" ? "active" : ""} onClick={() => setToolModalTab("info")}>Info</button><button type="button" role="tab" aria-selected={toolModalTab === "test"} className={toolModalTab === "test" ? "active" : ""} onClick={() => setToolModalTab("test")}>Test tool</button></div>{toolModalTab === "info" ? <div className="tool-modal-panel" role="tabpanel"><p>{selected.description}</p><dl className="tool-detail-list"><dt>Connection</dt><dd>{selected.connection_type === "mcp" ? "MCP" : "Custom · LangChain"}</dd><dt>Source</dt><dd>{selected.source_name}</dd><dt>Owner</dt><dd>{selected.owner_email}</dd><dt>Category</dt><dd>{selected.category}</dd><dt>Effect</dt><dd>{selected.effect} ({selected.effect_source})</dd></dl><details><summary>Developer details</summary><pre>{JSON.stringify(selected.input_schema, null, 2)}</pre></details><label className="tool-agent-select">Add to agent<select value={targetAgentId} onChange={(event) => setTargetAgentId(event.target.value)}><option value="">Select an agent</option>{agents.map((agent) => <option value={agent.agent_id} key={agent.agent_id}>{agent.agent_name}</option>)}</select></label><div className="marketplace-form-actions"><button type="button" className="marketplace-icon-button danger-icon" disabled={busy} onClick={() => void removeTool(selected)} aria-label={`Delete ${selected.display_name}`} title="Delete"><MarketplaceActionIcon name="trash" /></button><button type="button" className="marketplace-icon-button primary-icon" disabled={!targetAgentId || busy} onClick={() => void addToAgent()} aria-label={`Add ${selected.display_name} to agent`} title="Add to agent"><MarketplaceActionIcon name="user-plus" /></button></div></div> : <form className="tool-modal-panel tool-test-panel" role="tabpanel" onSubmit={runTest}><div className="tool-test-guide"><strong>How to test this tool</strong><ol><li>Review the required and optional inputs.</li><li>Load the example JSON or enter your own values.</li><li>Run the tool and inspect its response below.</li></ol></div><section className="tool-input-guide"><header><div><h2>Inputs</h2><p>{selectedInputFields.length ? `${selectedInputFields.length} declared input${selectedInputFields.length === 1 ? "" : "s"}` : "This tool has no declared inputs."}</p></div><button type="button" className="marketplace-icon-button secondary-icon" onClick={() => { setTestInput(JSON.stringify(selectedExampleInput, null, 2)); setTestInputError(null); }} aria-label="Use example JSON" title="Use example JSON"><MarketplaceActionIcon name="json" /></button></header>{selectedInputFields.length > 0 && <div className="tool-input-list">{selectedInputFields.map((field) => <article key={field.name}><div><code>{field.name}</code><span className={field.required ? "required" : "optional"}>{field.required ? "Required" : "Optional"}</span></div><strong>{schemaType(field.schema)}</strong>{typeof field.schema.description === "string" && <p>{field.schema.description}</p>}{field.schema.default !== undefined && <small>Default: {JSON.stringify(field.schema.default)}</small>}{Array.isArray(field.schema.enum) && <small>Allowed: {field.schema.enum.map((value) => String(value)).join(", ")}</small>}</article>)}</div>}</section><details className="tool-developer-options"><summary>Developer options</summary><h3>Input schema</h3><pre>{JSON.stringify(selected.input_schema, null, 2)}</pre>{selected.output_schema && <><h3>Output schema</h3><pre>{JSON.stringify(selected.output_schema, null, 2)}</pre></>}</details><label>Arguments JSON<textarea rows={10} aria-invalid={Boolean(testInputError)} value={testInput} onChange={(event) => { setTestInput(event.target.value); setTestInputError(null); }} />{testInputError && <span className="field-error" role="alert">{testInputError}</span>}</label><button className="marketplace-icon-button primary-icon" disabled={busy} aria-label="Run tool test" title="Run test">{busy ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="play" />}</button>{testResult && <div className={`test-result ${testResult.outcome}`}><strong>{testResult.outcome} · {testResult.duration_ms}ms</strong><pre>{JSON.stringify(testResult.output ?? testResult.error, null, 2)}</pre></div>}</form>}</section></div>}
    {editingSource && <div className="marketplace-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeMcpEdit(); }}><section className="marketplace-dialog"><div className="agent-modal-header"><h1>Edit MCP Server</h1><button type="button" className="marketplace-icon-button close-icon" disabled={busy} onClick={closeMcpEdit} aria-label="Close MCP server editor" title="Close"><MarketplaceActionIcon name="close" /></button></div><form className="marketplace-form" onSubmit={submitMcpEdit}><label>Name<input required value={mcpForm.name} onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })} /></label><label>Description<textarea value={mcpForm.description} onChange={(event) => setMcpForm({ ...mcpForm, description: event.target.value })} /></label><label>Streamable HTTP endpoint<input type="url" required value={mcpForm.endpoint} onChange={(event) => setMcpForm({ ...mcpForm, endpoint: event.target.value })} /></label><button className="marketplace-icon-button primary-icon form-icon-action" disabled={busy} aria-label="Save and refresh MCP server" title="Save & refresh">{busy ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="save" />}</button></form></section></div>}
    {dialog && <div className="marketplace-dialog-backdrop"><section className="marketplace-dialog"><div className="agent-modal-header"><h1>{dialog === "mcp" ? "Register MCP Server" : "Create Python Tool"}</h1><button type="button" className="marketplace-icon-button close-icon" onClick={() => setDialog(null)} aria-label="Close dialog" title="Close"><MarketplaceActionIcon name="close" /></button></div>{dialog === "mcp" ? <form className="marketplace-form" onSubmit={submitMcp}><label>Name<input required value={mcpForm.name} onChange={(e) => setMcpForm({...mcpForm,name:e.target.value})} /></label><label>Description<textarea value={mcpForm.description} onChange={(e) => setMcpForm({...mcpForm,description:e.target.value})} /></label><label>Streamable HTTP endpoint<input type="url" required value={mcpForm.endpoint} onChange={(e) => setMcpForm({...mcpForm,endpoint:e.target.value})} /></label><button className="marketplace-icon-button primary-icon form-icon-action" disabled={busy} aria-label="Register and discover MCP server" title="Register & discover">{busy ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="connect" />}</button></form> : <form className="marketplace-form" onSubmit={submitCustom}><label>Function name<input required value={customForm.name} onChange={(e) => setCustomForm({...customForm,name:e.target.value})} /></label><label>Display name<input value={customForm.display_name} onChange={(e) => setCustomForm({...customForm,display_name:e.target.value})} /></label><label>Description<textarea required value={customForm.description} onChange={(e) => setCustomForm({...customForm,description:e.target.value})} /></label><label>Category<input value={customForm.category} onChange={(e) => setCustomForm({...customForm,category:e.target.value})} /></label><label>Effect<select value={customForm.effect} onChange={(e) => setCustomForm({...customForm,effect:e.target.value as ToolEffect})}>{["read","calculate","write","delete","unknown"].map((value) => <option key={value}>{value}</option>)}</select></label><PythonEditor value={customForm.source_code} onChange={(source_code) => setCustomForm({...customForm,source_code})} /><button className="marketplace-icon-button primary-icon form-icon-action" disabled={busy} aria-label="Save custom tool" title="Save custom tool"><MarketplaceActionIcon name="save" /></button></form>}</section></div>}
    {toast && <ToastBar toast={toast} onClose={() => { window.clearTimeout(toastTimerRef.current); setToast(null); }} />}
  </section>;
}

const ANALYTICS_CHART_FONT = '"Source Sans 3", sans-serif';
const ANALYTICS_AXIS_LABEL_STYLE: Highcharts.CSSObject = { color: "#536577", fontFamily: ANALYTICS_CHART_FONT, fontSize: "12px", fontWeight: "400" };
const ANALYTICS_AXIS_TITLE_STYLE: Highcharts.CSSObject = { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "13px", fontWeight: "600" };
const ANALYTICS_LEGEND_STYLE: Highcharts.CSSObject = { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "12px", fontWeight: "600" };

function columnChart(title: string, categories: string[], series: Array<{ name: string; data: number[] }>, valueSuffix = ""): Highcharts.Options {
  return {
    chart: { type: "column", backgroundColor: "transparent", height: 330, style: { fontFamily: ANALYTICS_CHART_FONT } },
    title: { text: title, align: "left", margin: 18, style: { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "16px", fontWeight: "600" } },
    xAxis: { categories, crosshair: true, labels: { autoRotation: [-35, -60], style: ANALYTICS_AXIS_LABEL_STYLE }, title: { style: ANALYTICS_AXIS_TITLE_STYLE } },
    yAxis: { min: 0, title: { text: "", style: ANALYTICS_AXIS_TITLE_STYLE }, labels: { style: ANALYTICS_AXIS_LABEL_STYLE } },
    legend: { enabled: series.length > 1, itemStyle: ANALYTICS_LEGEND_STYLE, itemHoverStyle: { color: "#235B91" } },
    tooltip: { shared: true, valueSuffix, style: { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "12px" } },
    credits: { enabled: false },
    colors: ["#2A5A94", "#CA714C", "#0D2B49"],
    plotOptions: { series: { dataLabels: { style: { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "11px", fontWeight: "600", textOutline: "none" } } } },
    series: series.map((item) => ({ type: "column", name: item.name, data: item.data })),
  };
}

function AnalyticsChart({ title, categories, series, valueSuffix }: { title: string; categories: string[]; series: Array<{ name: string; data: number[] }>; valueSuffix?: string }) {
  return <article className="analytics-chart">{categories.length ? <HighchartsReact highcharts={Highcharts} options={columnChart(title, categories, series, valueSuffix)} /> : <><h2>{title}</h2><p className="analytics-empty">No priced usage is available for this chart.</p></>}</article>;
}

const ANALYTICS_MODEL_COLORS = ["#2A5A94", "#CA714C", "#0D2B49", "#10A37F", "#8B5CF6", "#D4B779"];

function AnalyticsTrendChart({ report, selectedModels, days }: { report: AnalyticsReport; selectedModels: string[]; days: 7 | 14 | 30 }) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const selected = new Set(selectedModels);
  const rows = report.daily_by_model.filter((row) => selected.has(row.model_id) && Date.parse(`${row.date}T00:00:00Z`) >= cutoff.getTime());
  const series: Highcharts.SeriesOptionsType[] = [];

  selectedModels.forEach((modelId, index) => {
    const modelRows = rows.filter((row) => row.model_id === modelId).sort((left, right) => left.date.localeCompare(right.date));
    if (!modelRows.length) return;
    const color = ANALYTICS_MODEL_COLORS[index % ANALYTICS_MODEL_COLORS.length];
    series.push({ type: "line", name: `${modelId} · Tokens`, color, yAxis: 0, data: modelRows.map((row) => [Date.parse(`${row.date}T00:00:00Z`), row.input_tokens + row.output_tokens]), marker: { enabled: true, radius: 3 }, tooltip: { valueDecimals: 0, valueSuffix: " tokens" } });
    const pricedRows = modelRows.filter((row) => row.cost_usd !== null);
    if (pricedRows.length) series.push({ type: "line", name: `${modelId} · Cost`, color, dashStyle: "Dash", yAxis: 1, data: pricedRows.map((row) => [Date.parse(`${row.date}T00:00:00Z`), row.cost_usd ?? 0]), marker: { enabled: true, radius: 3 }, tooltip: { valueDecimals: 6, valuePrefix: "$" } });
  });

  const options: Highcharts.Options = {
    chart: { type: "line", backgroundColor: "transparent", height: 390, style: { fontFamily: ANALYTICS_CHART_FONT } },
    title: { text: "Daily token usage and estimated cost by model", align: "left", margin: 18, style: { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "18px", fontWeight: "600" } },
    xAxis: { type: "datetime", title: { text: "Date", style: ANALYTICS_AXIS_TITLE_STYLE }, labels: { format: "{value:%b %e}", style: ANALYTICS_AXIS_LABEL_STYLE }, crosshair: true },
    yAxis: [
      { min: 0, title: { text: "Total tokens", style: ANALYTICS_AXIS_TITLE_STYLE }, labels: { style: ANALYTICS_AXIS_LABEL_STYLE } },
      { min: 0, title: { text: "Estimated cost (USD)", style: ANALYTICS_AXIS_TITLE_STYLE }, labels: { format: "${value:.4f}", style: ANALYTICS_AXIS_LABEL_STYLE }, opposite: true },
    ],
    legend: { enabled: true, itemStyle: ANALYTICS_LEGEND_STYLE, itemHoverStyle: { color: "#235B91" } },
    tooltip: { shared: true, xDateFormat: "%b %e, %Y", style: { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "12px" } },
    credits: { enabled: false },
    plotOptions: { series: { dataLabels: { style: { color: "#102D4E", fontFamily: ANALYTICS_CHART_FONT, fontSize: "11px", fontWeight: "600", textOutline: "none" } } } },
    series,
  };

  return <article className="analytics-chart analytics-trend-chart">{series.length ? <HighchartsReact highcharts={Highcharts} options={options} /> : <><h2>Daily token usage and estimated cost by model</h2><p className="analytics-empty">No usage is available for the selected models and date range.</p></>}</article>;
}

function AnalyticsDashboard() {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [trendDays, setTrendDays] = useState<7 | 14 | 30>(30);
  const [selectedModels, setSelectedModels] = useState<string[]>([ "gpt-4.1-mini",
  "gpt-5.4-mini"]);
  const initializedModels = useRef(false);

  function load() {
    setLoading(true); setLoadError("");
    getAnalytics().then(setReport).catch((reason: Error) => setLoadError(reason.message)).finally(() => setLoading(false));
  }

  useEffect(load, []);

  useEffect(() => {
    if (!report) return;
    const availableModels = report.by_model.map((row) => row.model_id);
    setSelectedModels((current) => initializedModels.current ? current.filter((modelId) => availableModels.includes(modelId)) : availableModels);
    initializedModels.current = true;
  }, [report]);

  if (loading) return <section className="content-page analytics-state" aria-live="polite"><p>Loading analytics…</p></section>;
  if (loadError) return <section className="content-page analytics-state"><div className="error-banner">{loadError}</div><button className="primary-button" onClick={load}>Retry</button></section>;
  if (!report) return null;

  const pricedModels = report.by_model.filter((row) => row.cost_usd !== null);
  const pricedAgents = report.by_agent.filter((row) => row.cost_usd !== null);
  const formatNumber = (value: number) => value.toLocaleString("en-US");
  const costLabel = report.summary.cost_usd === null ? report.summary.cost_status : `$${report.summary.cost_usd.toFixed(6)}`;

  return <section className="content-page"><header className="content-page-header"><div><p className="eyebrow">LAST {report.lookback_days} DAYS</p><h1>Analytics</h1><p>Model usage, agent activity, token consumption, and estimated OpenAI cost.</p></div><button className="secondary-button" onClick={load}>Refresh</button></header><div className="analytics-summary"><article><span>Interactions</span><strong>{formatNumber(report.summary.interaction_count)}</strong></article><article><span>Input tokens</span><strong>{formatNumber(report.summary.input_tokens)}</strong></article><article><span>Output tokens</span><strong>{formatNumber(report.summary.output_tokens)}</strong></article><article><span>Estimated cost</span><strong className={report.summary.cost_usd === null ? "cost-unavailable" : ""}>{costLabel}</strong></article></div>{report.by_model.some((row) => row.cost_usd === null) && <p className="analytics-note">Cost charts omit models without configured pricing; unavailable cost is not treated as zero.</p>}<div className="analytics-trend-filters"><label>Date range<select value={trendDays} onChange={(event) => setTrendDays(Number(event.target.value) as 7 | 14 | 30)}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option></select></label><fieldset><legend>Models</legend><div className="analytics-model-filters">{report.by_model.map((row) => <label key={row.model_id}><input type="checkbox" checked={selectedModels.includes(row.model_id)} onChange={(event) => setSelectedModels((current) => event.target.checked ? [...current, row.model_id] : current.filter((modelId) => modelId !== row.model_id))} /><span>{row.model_id}</span></label>)}</div><div className="analytics-filter-actions"><button type="button" onClick={() => setSelectedModels(report.by_model.map((row) => row.model_id))}>Select all</button><button type="button" onClick={() => setSelectedModels([])}>Clear</button></div></fieldset></div><div className="analytics-grid"><AnalyticsTrendChart report={report} selectedModels={selectedModels} days={trendDays} /><AnalyticsChart title="Cost by model" categories={pricedModels.map((row) => row.model_id)} series={[{ name: "Cost", data: pricedModels.map((row) => row.cost_usd ?? 0) }]} valueSuffix=" USD" /><AnalyticsChart title="Cost by agent" categories={pricedAgents.map((row) => row.agent_name || row.agent_id)} series={[{ name: "Cost", data: pricedAgents.map((row) => row.cost_usd ?? 0) }]} valueSuffix=" USD" /><AnalyticsChart title="Token usage by model" categories={report.by_model.map((row) => row.model_id)} series={[{ name: "Input tokens", data: report.by_model.map((row) => row.input_tokens) }, { name: "Output tokens", data: report.by_model.map((row) => row.output_tokens) }]} /><AnalyticsChart title="Interactions by model" categories={report.by_model.map((row) => row.model_id)} series={[{ name: "Interactions", data: report.by_model.map((row) => row.interaction_count) }]} /><AnalyticsChart title="Interactions by agent" categories={report.by_agent.map((row) => row.agent_name || row.agent_id)} series={[{ name: "Interactions", data: report.by_agent.map((row) => row.interaction_count) }]} /></div></section>;
}

function AgentManager({ agents, loading, onCreated, onUpdated, onDeleted }: { agents: Agent[]; loading: boolean; onCreated: (agent: Agent) => void; onUpdated: (agent: Agent) => void; onDeleted: (agentId: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [viewingAgent, setViewingAgent] = useState<Agent | null>(null);
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
  const [toolDraft, setToolDraft] = useState<{ index: number | null; tool: AgentTool } | null>(null);
  const [toolConfigTab, setToolConfigTab] = useState<"configure" | "test">("configure");
  const [toolDraftError, setToolDraftError] = useState("");
  const [inlineTestInput, setInlineTestInput] = useState("{}");
  const [inlineTestInputError, setInlineTestInputError] = useState("");
  const [inlineTestResult, setInlineTestResult] = useState<InlineToolTestResult | null>(null);
  const [toolTesting, setToolTesting] = useState(false);
  const [policyText, setPolicyText] = useState("");
  const [blockedTopics, setBlockedTopics] = useState("");
  const [fallback, setFallback] = useState("");
  const [selectedGuardrail, setSelectedGuardrail] = useState<"policy" | "blocked" | "fallback">("policy");
  const [toolSearch, setToolSearch] = useState("");
  const [serverFilter, setServerFilter] = useState("");

  const uniqueServers = useMemo(() => {
    const set = new Set<string>();
    for (const tool of libraryTools) {
      if (tool.status !== "available") continue;
      const serverName = tool.source_name || (tool.connection_type === "mcp" ? "MCP Server" : "Custom Tools");
      set.add(serverName);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [libraryTools]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const activeAgent = editingAgent ?? viewingAgent;
  const readOnly = Boolean(viewingAgent);
  const wizardOpen = creating || readOnly;
  const availableModels = activeAgent && !MODEL_OPTIONS.some((model) => model.id === activeAgent.model_id)
    ? [...MODEL_OPTIONS, { id: activeAgent.model_id, type: activeAgent.model_type, label: `${activeAgent.model_id} (${activeAgent.model_type})`, available: true }]
    : MODEL_OPTIONS;

  useEffect(() => { getTools().then(setLibraryTools).catch(() => setLibraryTools([])); }, []);

  function addLibraryTool(tool: ToolDefinition) {
    if (tools.some((item) => item.tool_definition_id === tool.tool_definition_id)) return;
    const newTool: AgentTool = {
      name: tool.external_name, description: tool.description, source_code: tool.source_code ?? "", enabled: true,
      connection_type: tool.connection_type, tool_definition_id: tool.tool_definition_id, source_id: tool.source_id,
      version: tool.version, category: tool.category, effect: tool.effect, effect_source: tool.effect_source,
      input_schema: tool.input_schema, approval_policy: "automatic", allowed_scope: {}, defaults: {},
    };
    const nextIndex = tools.length;
    setTools((items) => [...items, newTool]);
    if (newTool.connection_type !== "mcp") openToolConfig(nextIndex, newTool);
  }

  function handleToolClick(tool: ToolDefinition) {
    const existingIndex = tools.findIndex((item) => item.tool_definition_id === tool.tool_definition_id);
    if (existingIndex >= 0) {
      if (tools[existingIndex]?.connection_type !== "mcp") openToolConfig(existingIndex, tools[existingIndex]);
    } else {
      addLibraryTool(tool);
    }
  }

  const mcpServerGroups = useMemo(() => {
    const query = toolSearch.trim().toLowerCase();
    const groupsMap = new Map<string, {
      key: string;
      serverName: string;
      connectionType: "mcp" | "custom_langchain";
      tools: ToolDefinition[];
    }>();

    for (const tool of libraryTools) {
      if (tool.status !== "available") continue;
      const serverName = tool.source_name || (tool.connection_type === "mcp" ? "MCP Server" : "Custom Tools");
      if (serverFilter && serverName !== serverFilter) continue;
      const isMatch = !query || [
        tool.display_name,
        tool.external_name,
        tool.description,
        tool.source_name,
        tool.category,
      ].some((val) => typeof val === "string" && val.toLowerCase().includes(query));

      if (!isMatch) continue;

      const groupKey = tool.source_id || tool.source_name || (tool.connection_type === "mcp" ? "mcp_default" : "custom_default");

      let group = groupsMap.get(groupKey);
      if (!group) {
        group = {
          key: groupKey,
          serverName,
          connectionType: tool.connection_type,
          tools: [],
        };
        groupsMap.set(groupKey, group);
      }
      group.tools.push(tool);
    }

    return Array.from(groupsMap.values()).sort((a, b) => {
      if (a.connectionType === b.connectionType) {
        return a.serverName.localeCompare(b.serverName, undefined, { sensitivity: "base" });
      }
      return a.connectionType === "mcp" ? -1 : 1;
    });
  }, [libraryTools, toolSearch, serverFilter]);
  const selectedModel = availableModels.find((model) => model.id === modelId && model.available) ?? availableModels.find((model) => model.available) ?? availableModels[0];

  function resetForm() {
    setName(""); setDescription(""); setModelId(MODEL_OPTIONS[0].id); setSystemPrompt(""); setUserPrompt(""); setInitiativeId("");
    setTools([]); setToolDraft(null); setToolConfigTab("configure"); setToolDraftError(""); setInlineTestInput("{}"); setInlineTestInputError(""); setInlineTestResult(null); setToolTesting(false); setPolicyText(""); setBlockedTopics(""); setFallback(""); setSelectedGuardrail("policy"); setToolSearch(""); setServerFilter(""); setStep(1); setError(""); setEditingAgent(null); setViewingAgent(null); setModelMenuOpen(false);
  }

  function openCreate() { resetForm(); setCreating(true); }
  function populateAgentForm(agent: Agent) {
    const guardrails = agent.guardrails ?? {};
    const allowedTopics = Array.isArray(guardrails.allowed_topics) ? guardrails.allowed_topics.filter((topic): topic is string => typeof topic === "string") : [];
    const savedBlockedTopics = Array.isArray(guardrails.blocked_topics) ? guardrails.blocked_topics.filter((topic): topic is string => typeof topic === "string") : [];
    const legacyPolicy = allowedTopics.length ? `Only allow requests related to these topics: ${allowedTopics.join(", ")}.` : "";
    setName(agent.agent_name); setDescription(agent.description); setModelId(agent.model_id);
    setSystemPrompt(agent.system_prompts[0] ?? ""); setUserPrompt(agent.user_prompts?.[0] ?? ""); setInitiativeId(agent.initiative_id ?? ""); setTools(agent.tooling.map((tool) => ({ ...tool })));
    setPolicyText(typeof guardrails.policy_text === "string" ? guardrails.policy_text : legacyPolicy); setBlockedTopics(savedBlockedTopics.join("\n")); setFallback(typeof guardrails.out_of_scope_response === "string" ? guardrails.out_of_scope_response : "");
    setStep(1); setError("");
  }
  function openEdit(agent: Agent) { resetForm(); populateAgentForm(agent); setEditingAgent(agent); setCreating(true); }
  function openView(agent: Agent) { resetForm(); populateAgentForm(agent); setViewingAgent(agent); }

  function closeModal() {
    if (saving) return;
    setCreating(false);
    resetForm();
  }

  useEffect(() => {
    if (!wizardOpen) return undefined;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") toolDraft ? closeToolConfig() : closeModal();
    };
    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [wizardOpen, saving, toolDraft, toolTesting]);

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
    if (targetStep === 2 && tools.some((tool) => !tool.name.trim() || !tool.description.trim() || (tool.connection_type !== "mcp" && !tool.source_code.trim()))) return "Complete or remove each tool before continuing.";
    if (targetStep === 3 && fallback.trim() && !policyText.trim() && !blockedTopics.trim()) return "Add a guardrail policy or blocked topic before configuring an out-of-scope response.";
    return "";
  }

  function next() {
    if (readOnly) { setError(""); setStep((value) => Math.min(4, value + 1)); return; }
    const message = validationError(step);
    if (message) { setError(message); return; }
    setError(""); setStep((value) => Math.min(4, value + 1));
  }

  function goToStep(nextStep: number) {
    if (saving) return;
    setError(""); setModelMenuOpen(false); setStep(nextStep);
  }
  function resetInlineTest() {
    setToolConfigTab("configure");
    setToolDraftError("");
    setInlineTestInput("{}");
    setInlineTestInputError("");
    setInlineTestResult(null);
  }

  function openToolConfig(index: number | null, tool: AgentTool) {
    if (tool.connection_type === "mcp") return;
    setToolDraft({ index, tool: { ...tool, connection_type: "custom_langchain" } });
    resetInlineTest();
  }

  function closeToolConfig() {
    if (toolTesting) return;
    setToolDraft(null);
    resetInlineTest();
  }

  function updateToolDraft(field: keyof AgentTool, value: string | boolean) {
    setToolDraft((draft) => draft ? { ...draft, tool: { ...draft.tool, [field]: value } } : draft);
    setToolDraftError("");
  }

  function toolDraftValidationError() {
    if (!toolDraft?.tool.name.trim() || !toolDraft.tool.description.trim() || !toolDraft.tool.source_code.trim()) return "Name, description, and Python source are required.";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(toolDraft.tool.name.trim())) return "Name must be a valid Python function name.";
    return "";
  }

  function saveToolConfig(event: FormEvent) {
    event.preventDefault();
    if (!toolDraft) return;
    const message = toolDraftValidationError();
    if (message) { setToolDraftError(message); return; }
    const nextTool = { ...toolDraft.tool, name: toolDraft.tool.name.trim(), description: toolDraft.tool.description.trim() };
    setTools((items) => toolDraft.index === null
      ? [...items, nextTool]
      : items.map((tool, index) => index === toolDraft.index ? nextTool : tool));
    closeToolConfig();
  }

  async function runInlineToolTest(event: FormEvent) {
    event.preventDefault();
    if (!toolDraft || toolDraft.tool.tool_definition_id) return;
    const message = toolDraftValidationError();
    if (message) { setToolDraftError(message); setToolConfigTab("configure"); return; }
    let arguments_: Record<string, unknown>;
    try {
      const parsed = JSON.parse(inlineTestInput) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arguments must be a JSON object");
      arguments_ = parsed as Record<string, unknown>;
      setInlineTestInputError("");
    } catch (reason) {
      setInlineTestInputError(reason instanceof Error ? reason.message : "Enter valid JSON arguments.");
      return;
    }
    setToolTesting(true); setInlineTestResult(null);
    try {
      setInlineTestResult(await testInlineTool({
        name: toolDraft.tool.name.trim(),
        description: toolDraft.tool.description.trim(),
        source_code: toolDraft.tool.source_code,
        arguments: arguments_,
      }));
    } catch (reason) {
      setInlineTestResult({ outcome: "error", output: null, error: reason instanceof Error ? reason.message : "Inline tool test failed.", duration_ms: 0 });
    } finally { setToolTesting(false); }
  }

  function addTool() {
    openToolConfig(null, { name: "", description: "", source_code: "", enabled: true, connection_type: "custom_langchain", approval_policy: "automatic" });
  }
  async function save() {
    const detailsError = validationError(1);
    if (detailsError) { setStep(1); setError(detailsError); return; }
    const toolsError = validationError(2);
    if (toolsError) { setStep(2); setError(toolsError); return; }
    const guardrailsError = validationError(3);
    if (guardrailsError) { setStep(3); setError(guardrailsError); return; }
    setSaving(true); setError("");
    const guardrails: AgentGuardrails = editingAgent ? { ...editingAgent.guardrails } : {};
    delete guardrails.allowed_topics;
    const normalizedBlockedTopics = Array.from(new Set(blockedTopics.split(/[\n,]/).map((topic) => topic.trim()).filter(Boolean)));
    if (policyText.trim()) guardrails.policy_text = policyText.trim(); else delete guardrails.policy_text;
    if (normalizedBlockedTopics.length) guardrails.blocked_topics = normalizedBlockedTopics; else delete guardrails.blocked_topics;
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
        const createPayload: AgentCreate = { ...updatePayload as Omit<Agent, "agent_id">, shared_with: [] };
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

  useEffect(() => {
    const titles = Array.from(document.querySelectorAll<HTMLElement>(".agent-grid .agent-card-heading h2"));
    const cleanups = titles.map((title, index) => {
      const agent = visibleAgents[index];
      if (!agent) return () => undefined;
      title.tabIndex = 0;
      title.setAttribute("role", "button");
      title.setAttribute("aria-label", `View ${agent.agent_name}`);
      const open = () => openView(agent);
      const handleKey = (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      };
      title.addEventListener("click", open);
      title.addEventListener("keydown", handleKey);
      return () => { title.removeEventListener("click", open); title.removeEventListener("keydown", handleKey); };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [visibleAgents]);

  if (loading) return <div className="agents-page"><div className="agents-page-header"><div><p className="eyebrow">AGENT MANAGEMENT</p><h1>Agents</h1><p>Create and manage the AI agents available in chat.</p></div></div><div className="agents-loading" role="status" aria-live="polite"><div className="conversation-loading" aria-hidden="true"><span /><span /><span /></div><p>Loading agents</p></div></div>;

  return <div className="agents-page"><div className="agents-page-header"><div><p className="eyebrow">AGENT MANAGEMENT</p><h1>Agents</h1><p>Create and manage the AI agents available in chat.</p></div><div className="agent-header-actions"><label className="catalog-search agent-search"><span className="sr-only">Search agents</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents" /></label><button className="primary-button" onClick={openCreate}>Create agent</button></div></div><div className="agent-grid">{visibleAgents.map((agent) => <article className="agent-card" key={agent.agent_id}><div className="agent-card-heading"><h2>{agent.agent_name}</h2><div className="card-actions"><button type="button" className="marketplace-icon-button secondary-icon agent-card-action" disabled={saving} onClick={() => openEdit(agent)} aria-label={`Edit ${agent.agent_name}`} title={`Edit ${agent.agent_name}`}><MarketplaceActionIcon name="edit" /></button><button type="button" className="marketplace-icon-button danger-icon agent-card-action" disabled={saving} onClick={() => void removeAgent(agent)} aria-label={`Delete ${agent.agent_name}`} title={`Delete ${agent.agent_name}`}><MarketplaceActionIcon name="trash" /></button></div></div><p title={agent.description || undefined}>{agent.description || "No description provided."}</p><span className="agent-model-tag" title={agent.model_id}>{agent.model_id}</span></article>)}{visibleAgents.length === 0 && <p className="catalog-empty">No agents match “{search.trim()}”.</p>}</div>{wizardOpen && <div className={`agent-modal-backdrop ${readOnly ? "read-only-agent" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}><section className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="create-agent-title"><div className="agent-modal-header"><div><p className="eyebrow">{readOnly ? "AGENT DETAILS" : editingAgent ? "EDIT AGENT" : "CREATE AGENT"}</p><h1 id="create-agent-title">{readOnly ? viewingAgent?.agent_name : editingAgent ? `Edit ${editingAgent.agent_name}` : "New agent"}</h1></div><button className="modal-close" type="button" onClick={closeModal} disabled={saving} aria-label={readOnly ? "Close agent details" : editingAgent ? "Close edit agent dialog" : "Close new agent dialog"}>×</button></div><div className="wizard-navigation-row"><div className="wizard-steps" aria-label={readOnly ? "Agent details sections" : editingAgent ? "Editing progress" : "Creation progress"}>
        {[
          { id: 1, label: "Setup", icon: "details" as const },
          { id: 2, label: "Tools", icon: "tools" as const },
          { id: 3, label: "Guardrails", icon: "guardrails" as const },
          { id: 4, label: "Review", icon: "review" as const },
        ].map((tabItem) => (
          <button
            type="button"
            className={`wizard-step-tab ${step === tabItem.id ? "active" : step > tabItem.id ? "complete" : ""}`}
            aria-current={step === tabItem.id ? "step" : undefined}
            disabled={saving}
            onClick={() => goToStep(tabItem.id)}
            key={tabItem.label}
          >
            <WizardStepIcon name={tabItem.icon} />
            <span>{tabItem.id}. {tabItem.label}</span>
          </button>
        ))}
      </div><div className="wizard-actions"><button className="secondary-button" onClick={() => step === 1 ? closeModal() : setStep((value) => value - 1)} disabled={saving}><MarketplaceActionIcon name={step === 1 ? "close" : "arrow-left"} /><span>{step === 1 ? readOnly ? "Close" : "Cancel" : "Back"}</span></button>{step < 4 ? <button className="primary-button" onClick={next}><span>Continue</span><MarketplaceActionIcon name="arrow-right" /></button> : readOnly ? <button className="primary-button" onClick={closeModal}><MarketplaceActionIcon name="close" /><span>Close</span></button> : <button className="primary-button" onClick={() => void save()} disabled={saving}><MarketplaceActionIcon name={editingAgent ? "save" : "plus"} /><span>{saving ? editingAgent ? "Saving…" : "Creating…" : editingAgent ? "Save changes" : "Create agent"}</span></button>}</div></div><div className={`agent-wizard ${step === 1 ? "setup-panel-step" : ""} ${step === 2 ? "tools-step" : ""} ${step === 3 ? "guardrails-panel-step" : ""} ${step === 4 ? "review-step" : ""}`}>
    {step === 1 && <div className="setup-step"><section className="setup-details"><div className="setup-section-heading"><span className="marketplace-category">AGENT SETUP</span><h2>Agent details</h2><p>Define the agent identity and model.</p></div><div className="wizard-fields"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} readOnly={readOnly} autoFocus={!readOnly} /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} readOnly={readOnly} rows={3} /></label><label>Initiative ID<input value={initiativeId} onChange={(event) => setInitiativeId(event.target.value)} readOnly={readOnly} placeholder="Optional initiative identifier" /></label><div className="model-picker" ref={modelPickerRef}><span className="model-picker-label">Model</span>{readOnly ? <div className="model-picker-trigger read-only-value">{selectedModel.label}</div> : <><button ref={modelTriggerRef} type="button" className="model-picker-trigger" aria-haspopup="listbox" aria-expanded={modelMenuOpen} onClick={() => { const opening = !modelMenuOpen; setModelMenuOpen(opening); if (opening) requestAnimationFrame(() => modelPickerRef.current?.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')?.focus()); }} onKeyDown={(event) => { if (event.key === "Escape") { setModelMenuOpen(false); return; } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setModelMenuOpen(true); requestAnimationFrame(() => modelPickerRef.current?.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')?.focus()); } }}>{selectedModel.label}<span aria-hidden="true">⌄</span></button>{modelMenuOpen && <div className="model-picker-list" role="listbox" aria-label="Model" onKeyDown={handleModelListKey}>{availableModels.map((model) => <button type="button" role="option" aria-selected={model.available && modelId === model.id} key={model.id} disabled={!model.available} className={model.available ? "" : "unavailable"} onClick={() => { setModelId(model.id); setModelMenuOpen(false); modelTriggerRef.current?.focus(); }}><span>{model.label}</span>{!model.available && <small>Coming soon</small>}</button>)}</div>}</>}</div></div></section><section className="setup-prompts"><div className="setup-section-heading"><span className="marketplace-category">PROMPT OPTIONS</span><h2>Prompts</h2><p>Set reusable system and user instructions.</p></div><div className="wizard-fields"><MarkdownPromptEditor label="System prompt" value={systemPrompt} onChange={setSystemPrompt} placeholder="Write system instructions using Markdown" readOnly={readOnly} /><MarkdownPromptEditor label="User prompt" value={userPrompt} onChange={setUserPrompt} placeholder="Write a reusable user prompt using Markdown" readOnly={readOnly} /></div></section></div>}
    {step === 2 && (
      <div className="agent-tooling-container">
        <div className="agent-tooling-left">
          <div className="tooling-section-header">
            <div>
              <span className="marketplace-category">AGENT TOOLING</span>
              <h2>Configured Tools</h2>
              <p>{tools.length} {tools.length === 1 ? "tool" : "tools"} attached to agent</p>
            </div>
            {!readOnly && <button type="button" className="secondary-button" onClick={addTool}>
              <MarketplaceActionIcon name="plus" />
              <span>Inline tool</span>
            </button>}
          </div>

          {tools.length === 0 ? (
            <div className="tooling-empty">
              <div className="marketplace-icon" aria-hidden="true">🛠</div>
              <p>No tools added to this agent yet</p>
              <small>Click any tool from the Tool Library on the right to attach it to this agent, or click "+ Inline tool" above.</small>
            </div>
          ) : (
            <div className="tooling-configured-content">
              <div className="agent-tools-grid">
                {tools.map((tool, index) => {
                  const isConfigurable = !readOnly && tool.connection_type !== "mcp";
                  return (
                    <article
                      key={index}
                      role={isConfigurable ? "button" : undefined}
                      tabIndex={isConfigurable ? 0 : undefined}
                      className={`marketplace-card catalog-card agent-tool-card ${isConfigurable ? "configurable" : ""}`}
                      onClick={() => isConfigurable && openToolConfig(index, tool)}
                      onKeyDown={(e) => {
                        if (isConfigurable && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          openToolConfig(index, tool);
                        }
                      }}
                    >
                      <div className="marketplace-icon">{tool.connection_type === "mcp" ? "MCP" : "PY"}</div>
                      <div className="marketplace-card-content">
                        <div className="agent-tool-card-top">
                          <div className="agent-tool-card-heading">
                            <span className="marketplace-category">{tool.connection_type === "mcp" ? "MCP" : "Custom"}</span>
                            <h2>{tool.name.trim() || `Untitled tool ${index + 1}`}</h2>
                          </div>
                          {!readOnly && <button
                            type="button"
                            className="marketplace-icon-button danger-icon"
                            title="Remove tool from agent"
                            aria-label={`Remove ${tool.name || "tool"} from agent`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setTools((items) => items.filter((_, i) => i !== index));
                            }}
                          >
                            <MarketplaceActionIcon name="trash" />
                          </button>}
                        </div>
                        {tool.description && <p className="agent-tool-card-desc">{tool.description}</p>}
                        <div className="tool-card-footer">
                          <div className="tool-badges">
                            <span className={`status-pill ${tool.enabled ? "available" : "unavailable"}`}>
                              {tool.enabled ? "Enabled" : "Disabled"}
                            </span>
                            {tool.approval_policy && (
                              <span className="approval-pill">{tool.approval_policy}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="agent-tooling-right">
          <div className="tooling-section-header">
            <div>
              <span className="marketplace-category">TOOL LIBRARY</span>
              <h2>Discover & Add Tools</h2>
              <p>Classified by MCP server · Click any tool to add to agent</p>
            </div>
          </div>

          <div className="tool-library-toolbar-controls">
            <label className="catalog-search marketplace-search">
              <span className="sr-only">Search tools or MCP servers</span>
              <input
                type="search"
                placeholder="Search tools or MCP servers…"
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
              />
            </label>
            <label className="sr-only" htmlFor="mcp-server-filter">Filter by MCP server</label>
            <select
              id="mcp-server-filter"
              value={serverFilter}
              onChange={(e) => setServerFilter(e.target.value)}
            >
              <option value="">All MCP Servers & Sources</option>
              {uniqueServers.map((s) => (
                <option value={s} key={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="tool-library-scroll-area">
            {mcpServerGroups.length === 0 ? (
              <p className="catalog-empty">
                {toolSearch.trim() || serverFilter ? "No tools match your search criteria." : "No tools available in the library."}
              </p>
            ) : (
              mcpServerGroups.map((group) => (
                <div key={group.key} className="tool-library-group-section">
                  <div className="tool-group-header">
                    <div className="tool-group-title">
                      <span className="marketplace-category">{group.serverName}</span>
                      <span className="tool-group-badge">{group.connectionType === "mcp" ? "MCP" : "Custom"}</span>
                    </div>
                    <span className="tool-group-count">{group.tools.length} {group.tools.length === 1 ? "tool" : "tools"}</span>
                  </div>
                  <div className="marketplace-grid tool-library-grid">
                    {group.tools.map((tool) => {
                      const isAdded = tools.some((item) => item.tool_definition_id === tool.tool_definition_id);
                      const canConfigure = isAdded && tool.connection_type !== "mcp";
                      return (
                        <article
                          key={tool.tool_definition_id}
                          className={`marketplace-card catalog-card tool-card-button ${isAdded ? "already-added" : ""}`}
                        >
                          <div className="marketplace-icon">{tool.connection_type === "mcp" ? "MCP" : "PY"}</div>
                          <div className="marketplace-card-content">
                            <h2 className="tool-card-title" title={tool.display_name}>{tool.display_name}</h2>
                            <p className="tool-card-description" title={tool.description}>{tool.description}</p>
                          </div>
                          <button
                            type="button"
                            className={`tool-library-card-action ${isAdded ? "added" : ""}`}
                            disabled={readOnly || (isAdded && !canConfigure)}
                            onClick={() => !readOnly && handleToolClick(tool)}
                            aria-label={isAdded ? canConfigure ? `Configure ${tool.display_name}` : `${tool.display_name} already added` : `Add ${tool.display_name}`}
                            title={isAdded ? canConfigure ? "Configure tool" : "Already added" : "Add tool"}
                          >
                            <MarketplaceActionIcon name={isAdded ? "check" : "plus"} />
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    )}
    {step === 3 && <div className="master-detail"><aside className="master-list guardrail-list"><div className="master-list-heading"><div><h2>Guardrails</h2><p>Select a guardrail to {readOnly ? "view" : "configure"}.</p></div></div><button type="button" className={selectedGuardrail === "policy" ? "active" : ""} aria-pressed={selectedGuardrail === "policy"} onClick={() => setSelectedGuardrail("policy")}><svg className="guardrail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg><span>Guardrail policy</span></button><button type="button" className={selectedGuardrail === "blocked" ? "active" : ""} aria-pressed={selectedGuardrail === "blocked"} onClick={() => setSelectedGuardrail("blocked")}><svg className="guardrail-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg><span>Blocked topics</span></button><button type="button" className={selectedGuardrail === "fallback" ? "active" : ""} aria-pressed={selectedGuardrail === "fallback"} onClick={() => setSelectedGuardrail("fallback")}><svg className="guardrail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg><span>Out-of-scope response</span></button></aside><section className="detail-panel guardrail-detail">{selectedGuardrail === "policy" ? <label>Guardrail policy<textarea value={policyText} onChange={(event) => setPolicyText(event.target.value)} readOnly={readOnly} rows={9} placeholder="Describe which requests this agent may handle and any restrictions it must enforce." /><small>Every user message is checked against this policy before tools run. The policy is also applied to the final model response.</small></label> : selectedGuardrail === "blocked" ? <label>Blocked topics<textarea value={blockedTopics} onChange={(event) => setBlockedTopics(event.target.value)} readOnly={readOnly} rows={8} placeholder="Enter one topic per line" /><small>Requests related to any listed topic are blocked before normal chat or tools run.</small></label> : <label>Out-of-scope response<textarea value={fallback} onChange={(event) => setFallback(event.target.value)} readOnly={readOnly} rows={7} placeholder="Response returned when the guardrail blocks a request" /><small>This is the refusal shown after a block; it does not define what should be blocked.</small></label>}</section></div>}
    {step === 4 && <div className="review"><div className="review-heading"><span className="marketplace-category">FINAL CHECK</span><h2>{editingAgent ? "Review your changes" : "Review your agent"}</h2><p>Confirm the configuration before saving.</p></div><div className="review-grid"><section className="review-section"><div className="review-section-heading"><span>01</span><h3>Agent details</h3></div><dl className="review-list"><dt>Name</dt><dd>{name}</dd><dt>Description</dt><dd>{description}</dd><dt>Initiative ID</dt><dd>{initiativeId || <span className="review-empty">Not configured</span>}</dd><dt>Model</dt><dd><span className="review-model-tag">{selectedModel.label}</span></dd></dl></section><section className="review-section"><div className="review-section-heading"><span>02</span><h3>Tools &amp; guardrails</h3></div><div className="review-summary-field"><strong>Tools</strong>{tools.length ? <div className="review-tool-tags">{tools.map((tool, index) => <span key={`${tool.name}-${index}`}>{tool.name || `Tool ${index + 1}`}</span>)}</div> : <span className="review-empty">No tools configured</span>}</div><div className="review-summary-field"><strong>Guardrail policy</strong><p>{policyText || <span className="review-empty">Not configured</span>}</p></div><div className="review-summary-field"><strong>Blocked topics</strong><p>{blockedTopics || <span className="review-empty">Not configured</span>}</p></div><div className="review-summary-field"><strong>Fallback response</strong><p>{fallback || <span className="review-empty">Not configured</span>}</p></div></section><section className="review-section review-prompts"><div className="review-section-heading"><span>03</span><h3>Prompts</h3></div><div className="review-prompt-grid"><article><h4>System prompt</h4>{systemPrompt ? <div className="review-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{systemPrompt}</ReactMarkdown></div> : <p className="review-empty">Not configured</p>}</article><article><h4>User prompt</h4>{userPrompt ? <div className="review-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{userPrompt}</ReactMarkdown></div> : <p className="review-empty">Not configured</p>}</article></div></section></div></div>}
    {error && <div className="error-banner">{error}</div>}
  </div>{toolDraft && <div className="tool-config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeToolConfig(); }}><section className="marketplace-dialog tool-config-dialog" role="dialog" aria-modal="true" aria-labelledby="tool-config-title"><div className="agent-modal-header"><div><p className="eyebrow">{toolDraft.tool.tool_definition_id ? "CUSTOM TOOL" : "INLINE TOOL"}</p><h1 id="tool-config-title">{toolDraft.index === null ? "New inline tool" : `Configure ${toolDraft.tool.name || "tool"}`}</h1></div><button type="button" className="marketplace-icon-button close-icon" disabled={toolTesting} onClick={closeToolConfig} aria-label="Close tool configuration" title="Close"><MarketplaceActionIcon name="close" /></button></div><div className="tool-modal-tabs" role="tablist" aria-label="Tool configuration"><button type="button" role="tab" aria-selected={toolConfigTab === "configure"} className={toolConfigTab === "configure" ? "active" : ""} onClick={() => setToolConfigTab("configure")}>Configure</button>{!toolDraft.tool.tool_definition_id && <button type="button" role="tab" aria-selected={toolConfigTab === "test"} className={toolConfigTab === "test" ? "active" : ""} onClick={() => setToolConfigTab("test")}>Test tool</button>}</div>{toolConfigTab === "configure" || toolDraft.tool.tool_definition_id ? <form className="marketplace-form tool-config-form" onSubmit={saveToolConfig}><label>Function name<input required value={toolDraft.tool.name} onChange={(event) => updateToolDraft("name", event.target.value)} /></label><label>Description<textarea required rows={3} value={toolDraft.tool.description} onChange={(event) => updateToolDraft("description", event.target.value)} /></label><PythonEditor value={toolDraft.tool.source_code} onChange={(value) => updateToolDraft("source_code", value)} /><label>Approval policy<select value={toolDraft.tool.approval_policy ?? "automatic"} onChange={(event) => updateToolDraft("approval_policy", event.target.value)}><option value="automatic">Automatic</option><option value="ask">Ask (stored; not executed in v1)</option><option value="disabled">Disabled</option></select></label><label className="checkbox-label"><input type="checkbox" checked={toolDraft.tool.enabled} onChange={(event) => updateToolDraft("enabled", event.target.checked)} />Enabled</label>{toolDraftError && <div className="error-banner" role="alert">{toolDraftError}</div>}<div className="tool-config-actions"><button type="button" className="secondary-button" onClick={closeToolConfig}>Cancel</button><button type="submit" className="primary-button"><MarketplaceActionIcon name="save" /><span>Save tool</span></button></div></form> : <form className="tool-modal-panel tool-test-panel inline-tool-test-panel" role="tabpanel" onSubmit={runInlineToolTest}><div className="tool-test-guide"><strong>Test the current unsaved code</strong><p>Provide a JSON object matching the function arguments. Testing does not save the tool.</p></div><label>Arguments JSON<textarea rows={9} aria-invalid={Boolean(inlineTestInputError)} value={inlineTestInput} onChange={(event) => { setInlineTestInput(event.target.value); setInlineTestInputError(""); }} />{inlineTestInputError && <span className="field-error" role="alert">{inlineTestInputError}</span>}</label><button className="primary-button inline-test-button" disabled={toolTesting}>{toolTesting ? <i className="loading-circle small" aria-hidden="true" /> : <MarketplaceActionIcon name="play" />}<span>{toolTesting ? "Running…" : "Run test"}</span></button>{inlineTestResult && <div className={`test-result ${inlineTestResult.outcome}`}><strong>{inlineTestResult.outcome} · {inlineTestResult.duration_ms}ms</strong><pre>{JSON.stringify(inlineTestResult.output ?? inlineTestResult.error, null, 2)}</pre></div>}</form>}</section></div>}</section></div>}</div>;
}

export default function App() {
  const { user, authEnabled, signingOut, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const conversationRoute = matchPath("/conversations/:sessionId", location.pathname);
  const routeSessionId = conversationRoute?.params.sessionId;
  const view = location.pathname.startsWith("/initiatives") ? "initiatives" : location.pathname === "/agents" ? "agents" : location.pathname === "/marketplace" ? "marketplace" : location.pathname === "/analytics" ? "analytics" : "chat";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const conversationLoadControllerRef = useRef<AbortController | null>(null);
  const routeDraftRef = useRef<Conversation | null>(null);
  const active = conversations.find((conversation) => conversation.id === activeId);
  const showTypingIndicator = streaming && active?.executionEvents !== undefined;
  const localDraft = conversations.find((conversation) => !conversation.sessionId && !conversation.messages.length);
  const savedConversations = conversations.filter((conversation) => conversation.id !== localDraft?.id).slice(0, 5);
  const sidebarConversations = localDraft ? [localDraft, ...savedConversations] : savedConversations;
  const selectedAgentName = agents.find((agent) => agent.agent_id === selectedAgent)?.agent_name ?? "Choose an agent";
  const conversationTitle = active?.messages.find((message) => message.role === "user")?.content ?? active?.title ?? "New conversation";
  const mobilePageTitle = view === "agents" ? "Agents" : view === "initiatives" ? "Initiatives" : view === "marketplace" ? "Marketplace" : view === "analytics" ? "Analytics" : conversationTitle;

  useEffect(() => {
    getAgents().then((items) => {
      setAgents(items);
      setSelectedAgent(items[0]?.agent_id ?? "");
    }).catch((reason: Error) => setError(reason.message)).finally(() => setAgentsLoading(false));
  }, []);

  useEffect(() => {
    getConversations().then((items) => {
      const saved = items.map(conversationFromSummary);
      setConversations((current) => {
        const draft = current.find((conversation) => !conversation.sessionId && !conversation.messages.length);
        return draft ? [draft, ...saved] : saved;
      });
    }).catch((reason: Error) => setError(reason.message)).finally(() => setConversationsLoading(false));
  }, []);

  useEffect(() => {
    if (!agentPickerOpen) return undefined;
    const dismissAgentPicker = (event: PointerEvent) => {
      if (!agentPickerRef.current?.contains(event.target as Node)) setAgentPickerOpen(false);
    };
    window.addEventListener("pointerdown", dismissAgentPicker);
    return () => window.removeEventListener("pointerdown", dismissAgentPicker);
  }, [agentPickerOpen]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        requestAnimationFrame(() => mobileMenuRef.current?.focus());
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileNavOpen]);

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
      await streamChat({ agent_id: agentId, user_prompt: text, session_id: conversation.sessionId }, (event) => {
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
      const detail = await getConversation(conversation.sessionId, controller.signal);
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
  const isEmptyConversation = !activeConversationLoading && !active?.messages.length;
  const conversationModelId = headerAgent?.model_id ?? (activeHistoryPending || activeConversationLoading ? "Loading model…" : "No model selected");

  const composer = <form className="composer-wrap" onSubmit={submit}><div className="composer"><div className="agent-picker-wrap" ref={agentPickerRef}><button type="button" className="agent-picker-trigger" aria-label={`Choose agent, currently ${selectedAgentName}`} title={selectedAgentName} aria-expanded={agentPickerOpen} onClick={() => setAgentPickerOpen((open) => !open)}><span className="agent-picker-plus" aria-hidden="true">+</span><span className="selected-agent-name">{selectedAgentName}</span><span className="selected-agent-acronym" aria-hidden="true">{selectedAgent ? agentInitials(selectedAgentName) : "AI"}</span></button>{agentPickerOpen && <div className="agent-picker" role="listbox" aria-label="Choose an agent">{agents.map((agent) => <button type="button" key={agent.agent_id} className={agent.agent_id === selectedAgent ? "agent-option active" : "agent-option"} onClick={() => selectAgent(agent.agent_id)} role="option" aria-selected={agent.agent_id === selectedAgent}><span>{agent.agent_name}</span><small>{agent.model_id}</small></button>)}</div>}</div><textarea ref={textareaRef} value={prompt} onChange={(event) => updatePrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(event); } }} placeholder={activeConversationLoading ? "Loading conversation..." : activeHistoryPending ? "Select the conversation again to retry" : selectedAgent ? `Ask ${selectedAgentName} anything...` : "Select an agent to begin"} disabled={!selectedAgent || streaming || activeHistoryPending} rows={1} /><button type="submit" className="send-button" aria-label="Send message" disabled={!prompt.trim() || !selectedAgent || streaming || activeHistoryPending}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V6m0 0-5 5m5-5 5 5" /></svg></button></div><p>AI Harness may make mistakes. Check important information.</p></form>;

  return <main className="app-shell">
    <aside id="mobile-navigation" aria-label="Application navigation" className={`${sidebarExpanded || mobileNavOpen ? "sidebar expanded" : "sidebar"}${mobileNavOpen ? " mobile-open" : ""}`} onPointerEnter={() => setSidebarExpanded(true)} onPointerLeave={() => setSidebarExpanded(false)} onPointerUp={(event) => { if ((event.target as Element).closest("button,a")) { setSidebarExpanded(false); setMobileNavOpen(false); } }} onFocusCapture={() => setSidebarExpanded(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSidebarExpanded(false); }}>
      <div className="brand"><span className="brand-monogram" title="Deln Bank" aria-label="Deln Bank">A</span><span className="brand-name">AI Harness</span><button type="button" className="mobile-drawer-close" onClick={() => { setMobileNavOpen(false); requestAnimationFrame(() => mobileMenuRef.current?.focus()); }} aria-label="Close navigation"><MarketplaceActionIcon name="close" /></button></div>
      <button className="new-chat" onClick={newChat} aria-label="New chat" title="New chat"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span className="sidebar-label">New chat</span></button>
      <nav className="nav-links"><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/agents" title="Agents"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6M12 4V2M7 7h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Z" /><circle cx="9" cy="13" r="1" /><circle cx="15" cy="13" r="1" /><path d="M9 17h6" /></svg><span className="sidebar-label">Agents</span></NavLink><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/initiatives" title="Initiatives"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></svg><span className="sidebar-label">Initiatives</span></NavLink><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/marketplace" title="Marketplace"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16l-1 11H5L4 9Z" /><path d="M8 9V6a4 4 0 0 1 8 0v3" /></svg><span className="sidebar-label">Marketplace</span></NavLink><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/analytics" title="Analytics"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16" /><path d="m7 15 4-4 3 2 5-6" /></svg><span className="sidebar-label">Analytics</span></NavLink></nav>
      <section className="conversation-history" aria-label="Conversations">
        <div className="conversation-heading"><div className="conversation-heading-title"><svg className="conversation-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14A2.5 2.5 0 0 1 21.5 8v7A2.5 2.5 0 0 1 19 17.5H10l-4.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2-2.5Z" /><path d="M8 11h8M8 14h5" /></svg><span className="section-label sidebar-label">Conversations</span></div><span className="section-divider" aria-hidden="true" /></div>
        <div className="history">{conversationsLoading ? <div className="conversation-loading" role="status" aria-label="Loading conversations"><span /><span /><span /></div> : sidebarConversations.map((conversation) => <button className={view === "chat" && conversation.id === activeId ? "history-item active" : "history-item"} key={conversation.id} onClick={() => openConversation(conversation)} title={conversation.title} aria-label={conversation.title}><svg className="history-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14A2.5 2.5 0 0 1 21.5 8v7A2.5 2.5 0 0 1 19 17.5H10l-4.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2-2.5Z" /></svg><span className="history-label">{conversation.title}</span></button>)}</div>
      </section>
      <div className="profile" title={authEnabled ? user.email : `Static user ${user.email}`}><span className="avatar" title={user.name}>{user.name.charAt(0).toUpperCase()}</span><span className="profile-identity"><span className="profile-name">{user.name}</span><span className="profile-email">{user.email}</span>{!authEnabled&&<span className="profile-mode">Static user</span>}</span>{authEnabled&&<button type="button" className="profile-logout" title="Log out" aria-label={`Log out ${user.name}`} disabled={signingOut} onClick={()=>void signOut()}>{signingOut?<i className="loading-circle small" aria-hidden="true"/>:<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5M14 8l4 4-4 4M8 12h10"/></svg>}</button>}</div>
    </aside>
    {mobileNavOpen && <button type="button" className="mobile-nav-backdrop" onClick={() => { setMobileNavOpen(false); requestAnimationFrame(() => mobileMenuRef.current?.focus()); }} aria-label="Close navigation" />}
    <section className={view === "chat" ? "workspace" : "workspace content-workspace"}>
      {view !== "chat" && <header className="mobile-topbar"><button ref={mobileMenuRef} type="button" className="mobile-menu-button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation" aria-controls="mobile-navigation" aria-expanded={mobileNavOpen}><span /><span /><span /></button><span className="mobile-page-label">{mobilePageTitle}</span></header>}
      <Routes><Route path="/" element={<Navigate to="/chat" replace />} /><Route path="/chat" element={null} /><Route path="/conversations/:sessionId" element={null} /><Route path="/agents" element={null} /><Route path="/initiatives" element={null} /><Route path="/initiatives/new" element={null} /><Route path="/initiatives/:initiativeId" element={null} /><Route path="/initiatives/:initiativeId/edit" element={null} /><Route path="/marketplace" element={null} /><Route path="/analytics" element={null} /><Route path="*" element={<Navigate to="/chat" replace />} /></Routes>
      {view === "initiatives" ? <InitiativeManagement /> : view === "agents" ? <AgentManager agents={agents} loading={agentsLoading} onCreated={agentCreated} onUpdated={agentUpdated} onDeleted={agentDeleted} /> : view === "marketplace" ? <ToolLibraryMarketplace agents={agents} onUpdated={agentUpdated} /> : view === "analytics" ? <AnalyticsDashboard /> : <>
      <header className="topbar"><button ref={mobileMenuRef} type="button" className="mobile-menu-button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation" aria-controls="mobile-navigation" aria-expanded={mobileNavOpen}><span /><span /><span /></button><span className="conversation-model" title={conversationModelId}>{conversationModelId}</span><span className="topbar-divider" aria-hidden="true" /><span className="conversation-title" title={conversationTitle} aria-label={conversationTitle}>{conversationTitle}</span></header>
      <div ref={chatBodyRef} className={!isEmptyConversation ? "chat-body transcript" : "chat-body welcome"}>
        {activeConversationLoading && <div className="transcript-loading" role="status" aria-label="Loading conversation"><span /><span /><span /><p>Loading conversation</p></div>}
        {isEmptyConversation && <div className="empty-conversation"><div className="welcome-content"><p className="eyebrow">AI HARNESS</p><h1>Where should we start?</h1><p>Ask your configured AI agent anything.</p><div className="suggestions"><button onClick={() => setPrompt("Analyse my portfolio allocation")}>Analyse my portfolio allocation</button><button onClick={() => setPrompt("Get the latest price for AAPL")}>Get a current stock price</button><button onClick={() => setPrompt("Calculate my net worth with stock holdings")}>Calculate my net worth with stock holdings</button></div></div>{composer}</div>}
        {active?.messages.map((message, index) => <article key={`${message.role}-${index}`} className={`message ${message.role}`}><div className="message-card"><div className="message-meta">{message.role === "assistant" ? <><span className="agent-avatar" aria-hidden="true">{agentInitials(conversationAgentName)}</span><span className="agent-status" title="Available" aria-label="Available" /><span>{conversationAgentName}</span></> : <span className="user-avatar">You</span>}</div>{message.response ? <MessageContent message={message.response} /> : <div className="message-text">{message.content}</div>}<time className="message-time">{formatMessageTime(message.createdAt) ?? "Just now"}</time>{message.role === "assistant" && message.response && <MessageActions message={message.response} executionEvents={message.executionEvents} executionAgentName={message.executionAgentName} executionStatus={message.executionStatus} />}</div></article>)}
        {showTypingIndicator && <AssistantTypingIndicator agentName={active?.executionAgentName ?? conversationAgentName} />}
        {(active?.executionEvents?.length ?? 0) > 0 && <LiveExecutionTrace events={active?.executionEvents ?? []} agentName={active?.executionAgentName ?? conversationAgentName} status={active?.executionStatus ?? "running"} />}
        {error && <div className="error-banner">{error}</div>}
      </div>
      {!isEmptyConversation && composer}
      </>}
    </section>
  </main>;
}
