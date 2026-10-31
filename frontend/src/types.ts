export type AgentTool = { name: string; description: string; source_code: string; enabled: boolean };

export type Agent = {
  agent_id: string;
  agent_name: string;
  description: string;
  workflow: string;
  model_id: string;
  model_type: "openai" | "ollama";
  tooling: AgentTool[];
  system_prompts: string[];
  guardrails: Record<string, unknown>;
};

export type AgentCreate = Omit<Agent, "agent_id"> & { owner_email: string; created_by: string; shared_with: string[]; user_prompts: string[] };
export type AgentUpdate = Partial<Omit<Agent, "agent_id">>;

export type ChartContent = {
  library: "highcharts";
  options: Record<string, unknown>;
};

export type ChatMessage = {
  type: "markdown" | "json" | "html" | "tool" | "chart";
  content: unknown;
};

export type ChatResponse = {
  chat_event_id: string;
  response: ChatMessage;
  model_response: Record<string, unknown>;
  session_id: string;
  chat_sequence_id: number;
};

export type ChatEvent = {
  type: string;
  response?: ChatResponse;
  detail?: string;
  tool_name?: string;
  [key: string]: unknown;
};

export type AnalyticsCostStatus = "available" | "partial" | "unavailable";

export type AnalyticsMetrics = {
  interaction_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_status: AnalyticsCostStatus;
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  cost_usd: number | null;
};

export type ModelAnalytics = AnalyticsMetrics & { model_id: string };

export type AgentAnalytics = AnalyticsMetrics & {
  agent_id: string;
  agent_name: string | null;
};

export type AnalyticsReport = {
  lookback_days: number;
  summary: AnalyticsMetrics;
  by_model: ModelAnalytics[];
  by_agent: AgentAnalytics[];
};

export type UserProfile = {
  name: string;
  emailId: string;
};

export type ConversationSummary = {
  session_id: string;
  agent_id: string;
  agent_name: string | null;
  title: string;
  interaction_count: number;
  last_activity_at: string;
};

export type ConversationDetailMessage = {
  role: "user" | "assistant";
  content: string;
  created_at: string;
  chat_sequence_id: number;
  response: ChatMessage | null;
};

export type ConversationDetail = ConversationSummary & {
  messages: ConversationDetailMessage[];
};

export type Conversation = {
  id: string;
  agentId?: string;
  sessionId?: string;
  chatSequenceId?: number;
  historyLoaded?: boolean;
  title: string;
  messages: Array<{ role: "user" | "assistant"; content: string; createdAt?: string; response?: ChatMessage }>;
};
