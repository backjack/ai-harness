export type AgentTool = {
  name: string; description: string; source_code: string; enabled: boolean;
  connection_type?: "custom_langchain" | "mcp"; tool_definition_id?: string; source_id?: string;
  version?: string | null; category?: string; effect?: ToolEffect; effect_source?: string;
  input_schema?: Record<string, unknown>; approval_policy?: "automatic" | "ask" | "disabled";
  allowed_scope?: Record<string, unknown>; defaults?: Record<string, unknown>;
};

export type ToolEffect = "read" | "calculate" | "write" | "delete" | "unknown";
export type ToolSource = { source_id: string; source_type: "mcp" | "custom"; name: string; description: string | null; endpoint: string | null; transport: string | null; owner_email: string; status: "available" | "unavailable"; last_error: string | null; last_checked_at: string | null; tool_count: number };
export type ToolDefinition = { tool_definition_id: string; source_id: string; external_name: string; display_name: string; description: string; connection_type: "mcp" | "custom_langchain"; input_schema: Record<string, unknown>; output_schema: Record<string, unknown> | null; version: string | null; category: string; effect: ToolEffect; effect_source: string; status: "available" | "unavailable"; examples: string[] | null; output_preview: unknown; source_code: string | null; enabled: boolean; source_name: string; owner_email: string; endpoint: string | null };
export type ToolTestResult = { execution_id: string; outcome: "success" | "error"; output: unknown; error: string | null; duration_ms: number };
export type InlineToolTestResult = { outcome: "success" | "error"; output: unknown; error: string | null; duration_ms: number };

export type AgentGuardrails = {
  policy_text?: string | null;
  allowed_topics?: string[];
  blocked_topics?: string[];
  out_of_scope_response?: string | null;
};

export type Agent = {
  agent_id: string;
  agent_name: string;
  description: string;
  initiative_id: string | null;
  model_id: string;
  model_type: "openai" | "ollama";
  tooling: AgentTool[];
  system_prompts: string[];
  user_prompts: string[];
  guardrails: AgentGuardrails;
};

export type AgentCreate = Omit<Agent, "agent_id"> & { owner_email: string; created_by: string; shared_with: string[] };
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
  event_id?: number;
  chat_event_id?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
  response?: ChatResponse;
  detail?: string;
  tool_name?: string;
  tool_call_id?: string;
  arguments?: unknown;
  result?: unknown;
  duration_ms?: number;
  error?: string;
  error_type?: string;
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

export type DailyModelAnalytics = ModelAnalytics & { date: string };

export type AgentAnalytics = AnalyticsMetrics & {
  agent_id: string;
  agent_name: string | null;
};

export type AnalyticsReport = {
  lookback_days: number;
  summary: AnalyticsMetrics;
  by_model: ModelAnalytics[];
  by_agent: AgentAnalytics[];
  daily_by_model: DailyModelAnalytics[];
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
  executionEvents?: ChatEvent[];
  executionAgentName?: string;
  executionStatus?: "running" | "completed" | "failed";
  title: string;
  messages: Array<{ role: "user" | "assistant"; content: string; createdAt?: string; response?: ChatMessage; executionEvents?: ChatEvent[]; executionAgentName?: string; executionStatus?: "completed" | "failed" }>;
};
