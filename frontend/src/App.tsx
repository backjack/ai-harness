import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import ReactMarkdown from "react-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { matchPath, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { createAgent, getAgents, getAnalytics, getConversation, getConversations, streamChat, updateAgent } from "./api";
import type { Agent, AgentCreate, AgentTool, AgentUpdate, AnalyticsReport, ChartContent, ChatEvent, ChatMessage, Conversation, ConversationSummary, UserProfile } from "./types";

const USER_PROFILE: UserProfile = { name: "Neeraj Sharma", emailId: "neerajs28288@gmail.com" };

function isChartContent(value: unknown): value is ChartContent {
  return Boolean(value && typeof value === "object" && (value as ChartContent).library === "highcharts"
    && typeof (value as ChartContent).options === "object" && (value as ChartContent).options);
}

function ChartView({ content }: { content: unknown }) {
  if (!isChartContent(content)) {
    return <pre className="json-view">{JSON.stringify(content, null, 2)}</pre>;
  }
  return <figure className="chart-view"><HighchartsReact highcharts={Highcharts} options={content.options as Highcharts.Options} /></figure>;
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

function MessageActions({ message }: { message: ChatMessage }) {
  const [status, setStatus] = useState("");

  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(success);
    } catch {
      setStatus("Could not access clipboard");
    }
    window.setTimeout(() => setStatus(""), 1800);
  }

  return <div className="message-actions">
    <button type="button" onClick={() => void copy(responseText(message), "Copied")}>Copy</button>
    <button type="button" onClick={() => void copy(window.location.href, "Link copied")}>Share</button>
    <span aria-live="polite">{status}</span>
  </div>;
}

function MarkdownPromptEditor({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  const [preview, setPreview] = useState(false);
  return <section className="markdown-editor"><div className="editor-heading"><strong>{label}</strong><div role="group" aria-label={`${label} mode`}><button type="button" className={!preview ? "active" : ""} onClick={() => setPreview(false)}>Edit</button><button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button></div></div>{preview ? <div className="markdown-preview">{value.trim() ? <ReactMarkdown>{value}</ReactMarkdown> : <p>Nothing to preview.</p>}</div> : <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={7} placeholder={placeholder} />}</section>;
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

function taskLabel(event: ChatEvent) {
  if (event.type === "agent.lookup.start") return "Loading Stock Portfolio Analyst";
  if (event.type === "session.initialized") return "Preparing conversation";
  if (event.type.includes("tool")) return `Retrieving market data${event.tool_name ? ` with ${String(event.tool_name)}` : ""}`;
  if (event.type.includes("model") || event.type === "agent.execution.start") return "Analyzing your request";
  if (event.type.includes("audit")) return "Saving conversation";
  return null;
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
      {tab === "apps" && apps.map((app) => <article className="marketplace-card" key={app.name}><div className="marketplace-icon" aria-hidden="true">{app.icon}</div><div><span className="marketplace-category">{app.category}</span><h2>{app.name}</h2><p>{app.description}</p></div><span className="sample-badge">Sample app</span></article>)}
      {tab === "mcp" && visibleMcpServers.map((server) => <article className="marketplace-card catalog-card" key={`${server.name}-${server.endpoint}`}><div className="marketplace-icon" aria-hidden="true">MCP</div><div><span className="marketplace-category">{server.transport}</span><h2>{server.name}</h2><p>{server.description}</p><code>{server.endpoint}</code></div></article>)}
      {tab === "tools" && visibleTools.map((tool) => <article className="marketplace-card catalog-card" key={tool.name}><div className="marketplace-icon" aria-hidden="true">AT</div><div><span className="marketplace-category">{tool.enabled ? "Enabled" : "Disabled"}</span><h2>{tool.name}</h2><p>{tool.description}</p><code>{tool.source_code}</code></div></article>)}
      {resultCount === 0 && <p className="catalog-empty">No marketplace items match “{search.trim()}”.</p>}
    </div>
    {dialog && <div className="marketplace-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}><section className="marketplace-dialog" role="dialog" aria-modal="true" aria-labelledby="marketplace-dialog-title"><div className="agent-modal-header"><div><p className="eyebrow">MARKETPLACE</p><h1 id="marketplace-dialog-title">{dialog === "mcp" ? "Register MCP Server" : "Create a Tool"}</h1></div><button className="modal-close" type="button" onClick={closeDialog} aria-label="Close dialog">×</button></div>
      {dialog === "mcp" ? <form className="marketplace-form" onSubmit={registerMcp}><label>Name<input value={mcpForm.name} onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })} /></label><label>Description<textarea rows={3} value={mcpForm.description} onChange={(event) => setMcpForm({ ...mcpForm, description: event.target.value })} /></label><label>Endpoint URL<input type="url" placeholder="https://mcp.example.com/server" value={mcpForm.endpoint} onChange={(event) => setMcpForm({ ...mcpForm, endpoint: event.target.value })} /></label><label>Transport<select value={mcpForm.transport} onChange={(event) => setMcpForm({ ...mcpForm, transport: event.target.value })}><option>Streamable HTTP</option><option>SSE</option></select></label>{formError && <div className="error-banner">{formError}</div>}<div className="marketplace-form-actions"><button type="button" className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" type="submit">Register</button></div></form>
      : <form className="marketplace-form" onSubmit={createTool}><label>Name<input placeholder="get_stock_price" value={toolForm.name} onChange={(event) => setToolForm({ ...toolForm, name: event.target.value })} /></label><label>Description<textarea rows={3} value={toolForm.description} onChange={(event) => setToolForm({ ...toolForm, description: event.target.value })} /></label><PythonEditor value={toolForm.source_code} onChange={(value) => setToolForm({ ...toolForm, source_code: value })} /><label className="checkbox-label"><input type="checkbox" checked={toolForm.enabled} onChange={(event) => setToolForm({ ...toolForm, enabled: event.target.checked })} /> Enabled</label>{formError && <div className="error-banner">{formError}</div>}<div className="marketplace-form-actions"><button type="button" className="secondary-button" onClick={closeDialog}>Cancel</button><button className="primary-button" type="submit">Create Tool</button></div></form>}
    </section></div>}
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

function AgentManager({ agents, onCreated, onUpdated }: { agents: Agent[]; onCreated: (agent: Agent) => void; onUpdated: (agent: Agent) => void }) {
  const [creating, setCreating] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [search, setSearch] = useState("");
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [modelId, setModelId] = useState(MODEL_OPTIONS[0].id);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [topics, setTopics] = useState("");
  const [fallback, setFallback] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const availableModels = editingAgent && !MODEL_OPTIONS.some((model) => model.id === editingAgent.model_id)
    ? [...MODEL_OPTIONS, { id: editingAgent.model_id, type: editingAgent.model_type, label: `${editingAgent.model_id} (${editingAgent.model_type})`, available: true }]
    : MODEL_OPTIONS;
  const selectedModel = availableModels.find((model) => model.id === modelId && model.available) ?? availableModels.find((model) => model.available) ?? availableModels[0];

  function resetForm() {
    setName(""); setDescription(""); setModelId(MODEL_OPTIONS[0].id); setSystemPrompt(""); setUserPrompt(""); setWorkflow("");
    setTools([]); setTopics(""); setFallback(""); setStep(1); setError(""); setEditingAgent(null); setModelMenuOpen(false);
  }

  function openCreate() { resetForm(); setCreating(true); }
  function openEdit(agent: Agent) {
    const guardrails = agent.guardrails ?? {};
    const allowedTopics = Array.isArray(guardrails.allowed_topics) ? guardrails.allowed_topics.filter((topic): topic is string => typeof topic === "string") : [];
    setEditingAgent(agent); setName(agent.agent_name); setDescription(agent.description); setModelId(agent.model_id);
    setSystemPrompt(agent.system_prompts[0] ?? ""); setUserPrompt(agent.user_prompts?.[0] ?? ""); setWorkflow(agent.workflow); setTools(agent.tooling.map((tool) => ({ ...tool })));
    setTopics(allowedTopics.join(", ")); setFallback(typeof guardrails.out_of_scope_response === "string" ? guardrails.out_of_scope_response : "");
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

  function next() {
    if (step === 1 && (!name.trim() || !description.trim())) { setError("Name and description are required."); return; }
    if (step === 3 && tools.some((tool) => !tool.name.trim() || !tool.description.trim() || !tool.source_code.trim())) { setError("Complete or remove each tool before continuing."); return; }
    setError(""); setStep((value) => Math.min(5, value + 1));
  }
  function updateTool(index: number, field: keyof AgentTool, value: string | boolean) {
    setTools((items) => items.map((tool, itemIndex) => itemIndex === index ? { ...tool, [field]: value } : tool));
  }
  async function save() {
    setSaving(true); setError("");
    const guardrails: Record<string, unknown> = editingAgent ? { ...editingAgent.guardrails } : {};
    const allowedTopics = topics.split(",").map((topic) => topic.trim()).filter(Boolean);
    if (allowedTopics.length) guardrails.allowed_topics = allowedTopics; else delete guardrails.allowed_topics;
    if (fallback.trim()) guardrails.out_of_scope_response = fallback.trim(); else delete guardrails.out_of_scope_response;
    const updatePayload: AgentUpdate = {
      agent_name: name.trim(), description: description.trim(), workflow: workflow.trim(), model_id: selectedModel.id,
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

  const agentQuery = search.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter((agent) => !agentQuery || [agent.agent_name, agent.description, agent.model_id].some((value) => value.toLocaleLowerCase().includes(agentQuery)))
    .sort((left, right) => left.agent_name.localeCompare(right.agent_name, undefined, { sensitivity: "base" }));

  return <div className="agents-page"><div className="agents-page-header"><div><p className="eyebrow">AGENT MANAGEMENT</p><h1>Agents</h1><p>Create and manage the AI agents available in chat.</p></div><div className="agent-header-actions"><label className="catalog-search agent-search"><span className="sr-only">Search agents</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents" /></label><button className="primary-button" onClick={openCreate}>Create agent</button></div></div><div className="agent-grid">{visibleAgents.map((agent) => <article className="agent-card" key={agent.agent_id}><div className="agent-card-heading"><h2>{agent.agent_name}</h2><button type="button" className="text-button" onClick={() => openEdit(agent)}>Edit</button></div><p>{agent.description || "No description provided."}</p><small>{agent.model_id}</small></article>)}{visibleAgents.length === 0 && <p className="catalog-empty">No agents match “{search.trim()}”.</p>}</div>{creating && <div className="agent-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}><section className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="create-agent-title"><div className="agent-modal-header"><div><p className="eyebrow">{editingAgent ? "EDIT AGENT" : "CREATE AGENT"}</p><h1 id="create-agent-title">{editingAgent ? `Edit ${editingAgent.agent_name}` : "New agent"}</h1></div><button className="modal-close" type="button" onClick={closeModal} disabled={saving} aria-label={editingAgent ? "Close edit agent dialog" : "Close new agent dialog"}>×</button></div><div className="wizard-steps" aria-label={editingAgent ? "Editing progress" : "Creation progress"}>{["Details", "Prompts", "Tools", "Guardrails", "Review"].map((label, index) => <span className={step === index + 1 ? "active" : step > index + 1 ? "complete" : ""} key={label}>{index + 1}. {label}</span>)}</div><div className="agent-wizard">
    {step === 1 && <div className="wizard-fields"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label><div className="model-picker" ref={modelPickerRef}><span className="model-picker-label">Model</span><button ref={modelTriggerRef} type="button" className="model-picker-trigger" aria-haspopup="listbox" aria-expanded={modelMenuOpen} onClick={() => { const opening = !modelMenuOpen; setModelMenuOpen(opening); if (opening) requestAnimationFrame(() => modelPickerRef.current?.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')?.focus()); }} onKeyDown={(event) => { if (event.key === "Escape") { setModelMenuOpen(false); return; } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setModelMenuOpen(true); requestAnimationFrame(() => modelPickerRef.current?.querySelector<HTMLButtonElement>('button[role="option"][aria-selected="true"]')?.focus()); } }}>{selectedModel.label}<span aria-hidden="true">⌄</span></button>{modelMenuOpen && <div className="model-picker-list" role="listbox" aria-label="Model" onKeyDown={handleModelListKey}>{availableModels.map((model) => <button type="button" role="option" aria-selected={model.available && modelId === model.id} key={model.id} disabled={!model.available} className={model.available ? "" : "unavailable"} onClick={() => { setModelId(model.id); setModelMenuOpen(false); modelTriggerRef.current?.focus(); }}><span>{model.label}</span>{!model.available && <small>Coming soon</small>}</button>)}</div>}</div><label>Workflow<textarea value={workflow} onChange={(event) => setWorkflow(event.target.value)} rows={4} placeholder="Describe the process this agent should follow" /></label></div>}
    {step === 2 && <div className="wizard-fields"><MarkdownPromptEditor label="System prompt" value={systemPrompt} onChange={setSystemPrompt} placeholder="Write system instructions using Markdown" /><MarkdownPromptEditor label="User prompt" value={userPrompt} onChange={setUserPrompt} placeholder="Write a reusable user prompt using Markdown" /></div>}
    {step === 3 && <div className="wizard-fields"><div className="field-heading"><div><h2>Tools</h2><p>Add trusted Python tools this agent can call.</p></div><button type="button" className="secondary-button" onClick={() => setTools((items) => [...items, { name: "", description: "", source_code: "", enabled: true }])}>Add tool</button></div>{tools.map((tool, index) => <div className="tool-editor" key={index}><button type="button" className="remove-button" onClick={() => setTools((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remove</button><label>Name<input value={tool.name} onChange={(event) => updateTool(index, "name", event.target.value)} /></label><label>Description<input value={tool.description} onChange={(event) => updateTool(index, "description", event.target.value)} /></label><PythonEditor value={tool.source_code} onChange={(value) => updateTool(index, "source_code", value)} /><label className="checkbox-label"><input type="checkbox" checked={tool.enabled} onChange={(event) => updateTool(index, "enabled", event.target.checked)} /> Enabled</label></div>)}</div>}
    {step === 4 && <div className="wizard-fields guardrails-step"><div><h2>Guardrails</h2><p>Define which requests this agent should accept and how it handles out-of-scope questions.</p></div><label>Allowed topics<input value={topics} onChange={(event) => setTopics(event.target.value)} placeholder="finance, portfolio analysis" /></label><label>Out-of-scope response<textarea value={fallback} onChange={(event) => setFallback(event.target.value)} rows={4} /></label></div>}
    {step === 5 && <div className="review"><h2>{editingAgent ? "Review your changes" : "Review your agent"}</h2><dl><dt>Name</dt><dd>{name}</dd><dt>Description</dt><dd>{description}</dd><dt>Model</dt><dd>{selectedModel.label}</dd><dt>System prompt</dt><dd className="review-markdown">{systemPrompt ? <ReactMarkdown>{systemPrompt}</ReactMarkdown> : "None"}</dd><dt>User prompt</dt><dd className="review-markdown">{userPrompt ? <ReactMarkdown>{userPrompt}</ReactMarkdown> : "None"}</dd><dt>Workflow</dt><dd>{workflow || "None"}</dd><dt>Tools</dt><dd>{tools.length || "None"}</dd><dt>Allowed topics</dt><dd>{topics || "None"}</dd><dt>Fallback</dt><dd>{fallback || "None"}</dd></dl></div>}
    {error && <div className="error-banner">{error}</div>}<div className="wizard-actions"><button className="secondary-button" onClick={() => step === 1 ? closeModal() : setStep((value) => value - 1)} disabled={saving}>{step === 1 ? "Cancel" : "Back"}</button>{step < 5 ? <button className="primary-button" onClick={next}>Continue</button> : <button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? editingAgent ? "Saving…" : "Creating…" : editingAgent ? "Save changes" : "Create agent"}</button>}</div>
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
  const [tasks, setTasks] = useState<string[]>([]);
  const [tasksCompleting, setTasksCompleting] = useState(false);
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
  }, [activeId, conversations, tasks]);

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
    } : item));
    setPrompt("");
    setError("");
    setStreaming(true);
    setTasksCompleting(false);
    setTasks(["Preparing your analyst"]);
    let finalResult: ChatEvent["response"];
    try {
      await streamChat({ agent_id: agentId, user_id: USER_PROFILE.emailId, user_prompt: text, session_id: conversation.sessionId }, (event) => {
        if (event.type === "final" && event.response) {
          finalResult = event.response;
          setTasksCompleting(true);
          return;
        }
        if (event.type === "error") { setError(String(event.detail ?? "The chat request failed.")); setTasks([]); setTasksCompleting(false); return; }
        const label = taskLabel(event);
        if (label) setTasks((items) => items.includes(label) ? items : [...items, label]);
      });
      if (finalResult) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 450));
        const result = finalResult;
        setConversations((items) => items.map((item) => item.id === conversationId ? {
          ...item, agentId, sessionId: result.session_id, chatSequenceId: result.chat_sequence_id,
          messages: [...item.messages, { role: "assistant", content: String(result.response.content), createdAt: new Date().toISOString(), response: result.response }],
        } : item));
        if (!conversation.sessionId) {
          if (routeDraftRef.current?.id === conversationId) routeDraftRef.current = null;
          navigate(conversationPath(result.session_id), { replace: true });
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The chat request failed.");
    } finally {
      setStreaming(false);
      setTasks([]);
      setTasksCompleting(false);
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

  const conversationAgentName = agents.find((agent) => agent.agent_id === active?.agentId)?.agent_name ?? selectedAgentName;
  const activeConversationLoading = conversationLoadingId === active?.id;
  const activeHistoryPending = Boolean(active?.sessionId && !active.historyLoaded);
  const headerAgent = agents.find((agent) => agent.agent_id === active?.agentId) ?? (!active?.sessionId ? agents.find((agent) => agent.agent_id === selectedAgent) : undefined);
  const conversationModelId = headerAgent?.model_id ?? (activeHistoryPending || activeConversationLoading ? "Loading model…" : "No model selected");

  return <main className="app-shell">
    <aside className={sidebarExpanded ? "sidebar expanded" : "sidebar"} onPointerEnter={() => setSidebarExpanded(true)} onPointerLeave={() => setSidebarExpanded(false)} onPointerUp={(event) => { if ((event.target as Element).closest("button,a")) setSidebarExpanded(false); }} onFocusCapture={() => setSidebarExpanded(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSidebarExpanded(false); }}>
      <div className="brand"><span className="brand-monogram" title="Deln Bank" aria-label="Deln Bank">A</span><span className="brand-name">AI Harness</span></div>
      <button className="new-chat" onClick={newChat} aria-label="New chat" title="New chat"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span className="sidebar-label">New chat</span></button>
      <nav className="nav-links"><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/agents" title="Agents"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3 3 0 0 1 0 5.8M16 14c2.8.3 5 2.7 5 5.5" /></svg><span className="sidebar-label">Agents</span></NavLink><button className="nav-item disabled" type="button" disabled title="Initiatives — Coming soon" aria-label="Initiatives — Coming soon"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" /></svg><span className="sidebar-label">Initiatives</span></button><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/marketplace" title="Marketplace"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h16l-1 11H5L4 9Z" /><path d="M8 9V6a4 4 0 0 1 8 0v3" /></svg><span className="sidebar-label">Marketplace</span></NavLink><NavLink className={({ isActive }) => isActive ? "nav-item active" : "nav-item"} to="/analytics" title="Analytics"><svg className="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16" /><path d="m7 15 4-4 3 2 5-6" /></svg><span className="sidebar-label">Analytics</span></NavLink></nav>
      <section className="conversation-history" aria-label="Conversations">
        <div className="conversation-heading"><div className="conversation-heading-title"><svg className="conversation-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14A2.5 2.5 0 0 1 21.5 8v7A2.5 2.5 0 0 1 19 17.5H10l-4.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2-2.5Z" /><path d="M8 11h8M8 14h5" /></svg><span className="section-label sidebar-label">Conversations</span></div><span className="section-divider" aria-hidden="true" /></div>
        <div className="history">{conversationsLoading ? <div className="conversation-loading" role="status" aria-label="Loading conversations"><span /><span /><span /></div> : sidebarConversations.map((conversation) => <button className={view === "chat" && conversation.id === activeId ? "history-item active" : "history-item"} key={conversation.id} onClick={() => openConversation(conversation)} title={conversation.title} aria-label={conversation.title}><svg className="history-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14A2.5 2.5 0 0 1 21.5 8v7A2.5 2.5 0 0 1 19 17.5H10l-4.5 3v-3A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2-2.5Z" /></svg><span className="history-label">{conversation.title}</span></button>)}</div>
      </section>
      <div className="profile" title={USER_PROFILE.emailId}><span className="avatar" title={USER_PROFILE.name}>{USER_PROFILE.name.charAt(0).toUpperCase()}</span><span className="profile-name">{USER_PROFILE.name}</span></div>
    </aside>
    <section className={view === "chat" ? "workspace" : "workspace content-workspace"}>
      <Routes><Route path="/" element={<Navigate to="/chat" replace />} /><Route path="/chat" element={null} /><Route path="/conversations/:sessionId" element={null} /><Route path="/agents" element={null} /><Route path="/marketplace" element={null} /><Route path="/analytics" element={null} /><Route path="*" element={<Navigate to="/chat" replace />} /></Routes>
      {view === "agents" ? <AgentManager agents={agents} onCreated={agentCreated} onUpdated={agentUpdated} /> : view === "marketplace" ? <Marketplace /> : view === "analytics" ? <AnalyticsDashboard /> : <>
      <header className="topbar"><span className="conversation-model" title={conversationModelId}>{conversationModelId}</span><span className="topbar-divider" aria-hidden="true" /><span className="conversation-title" title={conversationTitle} aria-label={conversationTitle}>{conversationTitle}</span></header>
      <div ref={chatBodyRef} className={active?.messages.length || activeConversationLoading ? "chat-body transcript" : "chat-body welcome"}>
        {activeConversationLoading && <div className="transcript-loading" role="status" aria-label="Loading conversation"><span /><span /><span /><p>Loading conversation</p></div>}
        {!activeConversationLoading && !active?.messages.length && <div className="welcome-content"><p className="eyebrow">AI HARNESS</p><h1>Where should we start?</h1><p>Ask your configured AI agent anything.</p><div className="suggestions"><button onClick={() => setPrompt("Analyse my portfolio allocation")}>Analyse my portfolio allocation</button><button onClick={() => setPrompt("Get the latest price for AAPL")}>Get a current stock price</button><button onClick={() => setPrompt("Calculate my net worth with stock holdings")}>Calculate my net worth with stock holdings</button></div></div>}
        {active?.messages.map((message, index) => <article key={`${message.role}-${index}`} className={`message ${message.role}`}><div className="message-card"><div className="message-meta">{message.role === "assistant" ? <><span className="agent-avatar" aria-hidden="true">SP</span><span className="agent-status" title="Available" aria-label="Available" /><span>{conversationAgentName}</span></> : <span className="user-avatar">You</span>}</div>{message.response ? <MessageContent message={message.response} /> : <div className="message-text">{message.content}</div>}<time className="message-time">{formatMessageTime(message.createdAt) ?? "Just now"}</time>{message.role === "assistant" && message.response && <MessageActions message={message.response} />}</div></article>)}
        {tasks.length > 0 && <section className={tasksCompleting ? "task-list is-completing" : "task-list"} aria-live="polite"><span>Working</span>{tasks.map((task) => <div className="task-row" key={task}><i /><span>{task}</span></div>)}</section>}
        {error && <div className="error-banner">{error}</div>}
      </div>
      <form className="composer-wrap" onSubmit={submit}><div className="composer"><div className="agent-picker-wrap"><button type="button" className="icon-button" aria-label="Choose agent" aria-expanded={agentPickerOpen} onClick={() => setAgentPickerOpen((open) => !open)}>+</button>{agentPickerOpen && <div className="agent-picker" role="listbox" aria-label="Choose an agent">{agents.map((agent) => <button type="button" key={agent.agent_id} className={agent.agent_id === selectedAgent ? "agent-option active" : "agent-option"} onClick={() => selectAgent(agent.agent_id)} role="option" aria-selected={agent.agent_id === selectedAgent}><span>{agent.agent_name}</span><small>{agent.model_id}</small></button>)}</div>}</div><span className="selected-agent" aria-live="polite" title={selectedAgentName}>{selectedAgentName}</span><textarea ref={textareaRef} value={prompt} onChange={(event) => updatePrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(event); } }} placeholder={activeConversationLoading ? "Loading conversation..." : activeHistoryPending ? "Select the conversation again to retry" : selectedAgent ? `Ask ${selectedAgentName} anything...` : "Select an agent to begin"} disabled={!selectedAgent || streaming || activeHistoryPending} rows={1} /><button type="submit" className="send-button" aria-label="Send message" disabled={!prompt.trim() || !selectedAgent || streaming || activeHistoryPending}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V6m0 0-5 5m5-5 5 5" /></svg></button></div><p>AI Harness may make mistakes. Check important information.</p></form>
      </>}
    </section>
  </main>;
}
