export const LIFECYCLE_STAGES = [
  "New",
  "Initiative Review",
  "In Development",
  "Governance Review",
  "QA Deployment",
  "Tech Review",
  "Prod Deployment",
  "Retired",
] as const;

export type LifecycleStage = typeof LIFECYCLE_STAGES[number];
export type StageStatus = "Not Started" | "In Progress" | "Pending Approval" | "Approved" | "Rejected" | "Completed" | "Retired";
export type Priority = "Critical" | "High" | "Medium" | "Low";
export type RiskLevel = "Low" | "Medium" | "High" | "Critical";
export type AiType = "Generative AI" | "Agentic AI" | "Predictive ML" | "Hybrid";
export type ReviewStatus = "Not Started" | "In Progress" | "Pending" | "Approved" | "Rejected" | "Completed";

export type UsagePoint = {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  requests: number;
};

export type InitiativeAgent = {
  agent_id: string;
  name: string;
  description: string;
  model: string;
  status: "Active" | "Testing" | "Inactive";
  tools_count: number;
  mcp_connections: number;
  input_tokens: number;
  output_tokens: number;
  total_cost: number;
  last_execution: string;
};

export type LifecycleEvent = {
  id: string;
  from_stage: LifecycleStage | null;
  to_stage: LifecycleStage;
  status: StageStatus;
  timestamp: string;
  approver: string;
  decision: string;
  comments: string;
};

export type DeploymentRecord = {
  environment: "Development" | "QA" | "Production";
  version: string;
  timestamp: string;
  approver: string;
  status: "Not Deployed" | "Healthy" | "Pending" | "Failed";
};

export type AuditEvent = {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  previous_value: string;
  updated_value: string;
  comments: string;
};

export type InitiativeApproval = {
  approval_type: "PTB" | "PTO" | "AI Governance";
  status: "Pending" | "Approved" | "Rejected";
  approved_by: string | null;
  approved_at: string | null;
  comments: string;
};

export type InitiativeAccess = {
  user_name: string;
  access_provided_at: string;
};

export type Initiative = {
  initiative_id: string;
  name: string;
  description: string;
  initiative_owner: string;
  product_owner: string;
  department_name: string;
  business_unit: string;
  commercial_use: boolean;
  business_objective: string;
  use_case_category: string;
  expected_business_value: string;
  priority: Priority;
  created_at: string;
  updated_at: string;
  target_go_live_date: string;
  current_state: LifecycleStage;
  stage_status: StageStatus;
  approval_status: ReviewStatus;
  governance_owner: string;
  technical_owner: string;
  qa_owner: string;
  deployment_date: string | null;
  last_review_date: string;
  next_review_date: string;
  number_of_agents: number;
  ai_type: AiType;
  model_providers: string[];
  models_used: string[];
  mcp_servers: number;
  tools_count: number;
  knowledge_sources: string[];
  vector_database: string;
  deployment_environment: "Development" | "QA" | "Production";
  human_in_the_loop: boolean;
  total_token_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  monthly_token_cost: number;
  estimated_monthly_cost: number;
  total_llm_requests: number;
  average_cost_per_request: number;
  monthly_budget: number;
  budget_utilization: number;
  last_activity_at: string;
  risk_level: RiskLevel;
  data_classification: "Public" | "Internal" | "Confidential" | "Highly Confidential";
  pii_processing: boolean;
  ai_governance_status: ReviewStatus;
  model_validation_status: ReviewStatus;
  security_review_status: ReviewStatus;
  compliance_status: ReviewStatus;
  audit_status: "Ready" | "Needs Attention" | "Not Assessed";
  guardrails_enabled: boolean;
  explainability_required: boolean;
  regulatory_frameworks: string[];
  eu_ai_act_risk_category: string;
  human_oversight_required: boolean;
  deployment_status: "Not Deployed" | "Development" | "QA" | "Production" | "Retired";
  availability_percentage: number;
  average_latency: number;
  error_rate: number;
  total_executions: number;
  last_execution_time: string;
  incident_count: number;
  monitoring_status: "Enabled" | "Disabled";
  owner_contact: string;
  cost_alert_threshold: number;
  usage: UsagePoint[];
  agents: InitiativeAgent[];
  lifecycle_history: LifecycleEvent[];
  deployments: DeploymentRecord[];
  audit_logs: AuditEvent[];
  approvals: InitiativeApproval[];
  access_list: InitiativeAccess[];
};

export type InitiativeDraft = Omit<Initiative, "initiative_id" | "created_at" | "updated_at" | "usage" | "agents" | "lifecycle_history" | "deployments" | "audit_logs">;
export type InitiativeTab = "overview" | "agents" | "usage" | "governance" | "lifecycle" | "deployments" | "audit";
