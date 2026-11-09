import type { AdminUser, Agent, AgentCreate, AgentUpdate, AnalyticsReport, AuthenticatedUser, ChatEvent, ConversationDetail, ConversationSummary, InlineToolTestResult, ToolDefinition, ToolSource, ToolTestResult } from "./types";

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
let accessToken: string | null = null;
let authenticationEnabled = true;
let unauthorizedHandler: ((accessDeniedMessage?: string) => void) | null = null;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function setAuthToken(token: string | null): void {
  accessToken = token;
}

export function setAuthEnabled(enabled: boolean): void {
  authenticationEnabled = enabled;
}

export function setUnauthorizedHandler(handler: ((accessDeniedMessage?: string) => void) | null): void {
  unauthorizedHandler = handler;
}

async function apiFetch(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authenticated && authenticationEnabled && !accessToken) {
    unauthorizedHandler?.();
    throw new Error("Authentication required");
  }
  if (authenticated && accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (authenticated && response.status === 401) unauthorizedHandler?.();
  if (authenticated && response.status === 403) {
    const error = await response.clone().json().catch(() => null) as { detail?: string } | null;
    if (error?.detail?.startsWith("Access is disabled for email ")) unauthorizedHandler?.(error.detail);
  }
  return response;
}

async function publicJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path, {}, false);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new ApiError(error?.detail ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new ApiError(error?.detail ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

async function apiNoContent(path: string, init: RequestInit): Promise<void> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new ApiError(error?.detail ?? `Request failed (${response.status})`, response.status);
  }
}

export const getAuthConfig = () => publicJson<{ auth_enabled: boolean; client_id: string | null }>("/auth/config");
export const getCurrentUser = () => apiJson<AuthenticatedUser>("/auth/me");
export const logoutCurrentUser = () => apiNoContent("/auth/logout", { method: "POST" });
export const getAdminUsers = () => apiJson<AdminUser[]>("/admin/users");
export const createAdminUser = (body: AdminUser) => apiJson<AdminUser>("/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const updateAdminUser = (email: string, body: Partial<Omit<AdminUser, "emailid">>) => apiJson<AdminUser>(`/admin/users/${encodeURIComponent(email)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const getToolSources = () => apiJson<ToolSource[]>("/tool-sources");
export const getTools = (query = "") => apiJson<ToolDefinition[]>(`/tools${query ? `?${query}` : ""}`);
export type ToolSourceTest = { source_id: string; status: "available" | "unavailable"; tool_count: number; error: string | null; duration_ms: number };
export const getToolsForSource = (sourceId: string) => getTools(new URLSearchParams({ source_id: sourceId }).toString());
export const registerMcpSource = (body: { name: string; description?: string; endpoint: string }) => apiJson<ToolSource & { test: ToolSourceTest }>("/tool-sources/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const updateMcpSource = (sourceId: string, body: { name: string; description?: string; endpoint: string }) => apiJson<ToolSource & { test: ToolSourceTest }>(`/tool-sources/${encodeURIComponent(sourceId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const testToolSource = (sourceId: string) => apiJson<ToolSourceTest>(`/tool-sources/${encodeURIComponent(sourceId)}/test`, { method: "POST" });
export const createCustomTool = (body: Record<string, unknown>) => apiJson<ToolDefinition>("/tools/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const testLibraryTool = (toolId: string, arguments_: Record<string, unknown>) => apiJson<ToolTestResult>(`/tools/${encodeURIComponent(toolId)}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ arguments: arguments_ }) });
export const testInlineTool = (body: { name: string; description: string; source_code: string; arguments: Record<string, unknown> }) => apiJson<InlineToolTestResult>("/tools/inline/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const deleteToolSource = (sourceId: string) => apiNoContent(`/tool-sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
export const deleteLibraryTool = (toolId: string) => apiNoContent(`/tools/${encodeURIComponent(toolId)}`, { method: "DELETE" });

export async function getAgents(): Promise<Agent[]> {
  return apiJson<Agent[]>("/agents");
}

export async function createAgent(body: AgentCreate): Promise<Agent> {
  return apiJson<Agent>("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateAgent(agentId: string, body: AgentUpdate): Promise<Agent> {
  return apiJson<Agent>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const deleteAgent = (agentId: string) => apiNoContent(`/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });

export async function getAnalytics(): Promise<AnalyticsReport> {
  return apiJson<AnalyticsReport>("/analytics");
}

export async function getConversations(): Promise<ConversationSummary[]> {
  return apiJson<ConversationSummary[]>("/conversations");
}

export async function getConversation(sessionId: string, signal?: AbortSignal): Promise<ConversationDetail> {
  return apiJson<ConversationDetail>(`/conversations/${encodeURIComponent(sessionId)}`, { signal });
}

export async function streamChat(body: {
  agent_id?: string;
  model_id?: string;
  user_prompt: string;
  session_id?: string;
}, onEvent: (event: ChatEvent) => void): Promise<void> {
  const response = await apiFetch("/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(error?.detail ?? `Chat request failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).find((line) => line.startsWith("data: "));
      if (data) onEvent(JSON.parse(data.slice(6)) as ChatEvent);
    }
    if (done) break;
  }
}
