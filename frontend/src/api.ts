import type { Agent, AgentCreate, AnalyticsReport, ChatEvent, ConversationDetail, ConversationSummary } from "./types";

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function getAgents(): Promise<Agent[]> {
  const response = await fetch(`${baseUrl}/agents`);
  if (!response.ok) throw new Error("Could not load agents");
  return response.json() as Promise<Agent[]>;
}

export async function createAgent(body: AgentCreate): Promise<Agent> {
  const response = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(error?.detail ?? "Could not create agent");
  }
  return response.json() as Promise<Agent>;
}

export async function getAnalytics(): Promise<AnalyticsReport> {
  const response = await fetch(`${baseUrl}/analytics`);
  if (!response.ok) throw new Error("Could not load analytics");
  return response.json() as Promise<AnalyticsReport>;
}

export async function getConversations(emailId: string): Promise<ConversationSummary[]> {
  const query = new URLSearchParams({ email_id: emailId });
  const response = await fetch(`${baseUrl}/conversations?${query}`);
  if (!response.ok) throw new Error("Could not load conversations");
  return response.json() as Promise<ConversationSummary[]>;
}

export async function getConversation(sessionId: string, emailId: string, signal?: AbortSignal): Promise<ConversationDetail> {
  const query = new URLSearchParams({ email_id: emailId });
  const response = await fetch(`${baseUrl}/conversations/${encodeURIComponent(sessionId)}?${query}`, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(error?.detail ?? "Could not load conversation");
  }
  return response.json() as Promise<ConversationDetail>;
}

export async function streamChat(body: {
  agent_id: string;
  user_id: string;
  user_prompt: string;
  session_id?: string;
}, onEvent: (event: ChatEvent) => void): Promise<void> {
  const response = await fetch(`${baseUrl}/chat/stream`, {
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
