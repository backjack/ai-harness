import { Initiative, InitiativeAgent, LifecycleStage, LIFECYCLE_STAGES, RiskLevel, AiType, Priority, UsagePoint } from "./types";

type Seed = {
  name: string;
  department: string;
  owner: string;
  productOwner: string;
  stage: LifecycleStage;
  risk: RiskLevel;
  aiType: AiType;
  priority: Priority;
  commercial: boolean;
  agents: number;
  model: string;
  monthlyBudget: number;
};

const seeds: Seed[] = [
  { name:"Intelligent Portfolio Advisor", department:"Wealth Management", owner:"John Smith", productOwner:"Sarah Wilson", stage:"Governance Review", risk:"Medium", aiType:"Agentic AI", priority:"High", commercial:true, agents:8, model:"gpt-5.4-mini", monthlyBudget:6200 },
  { name:"AI Compliance Monitoring", department:"Compliance", owner:"Priya Nair", productOwner:"Daniel Brooks", stage:"Prod Deployment", risk:"High", aiType:"Hybrid", priority:"Critical", commercial:false, agents:5, model:"gpt-4.1-mini", monthlyBudget:8900 },
  { name:"Automated KYC Review", department:"Operations", owner:"Elena Garcia", productOwner:"Marcus Lee", stage:"QA Deployment", risk:"High", aiType:"Agentic AI", priority:"High", commercial:false, agents:6, model:"gpt-5.4-mini", monthlyBudget:5100 },
  { name:"Transaction Anomaly Detection", department:"Risk Management", owner:"David Chen", productOwner:"Aisha Patel", stage:"Tech Review", risk:"Critical", aiType:"Predictive ML", priority:"Critical", commercial:false, agents:4, model:"gpt-5.6-luna", monthlyBudget:12000 },
  { name:"AI Investment Research Assistant", department:"Investment Banking", owner:"Olivia Martin", productOwner:"Noah Williams", stage:"In Development", risk:"Medium", aiType:"Generative AI", priority:"High", commercial:true, agents:7, model:"gpt-5.4-mini", monthlyBudget:7400 },
  { name:"Customer Support AI Agent", department:"Operations", owner:"Sophia Brown", productOwner:"Liam Davis", stage:"Prod Deployment", risk:"Medium", aiType:"Agentic AI", priority:"High", commercial:true, agents:6, model:"gpt-4.1-mini", monthlyBudget:9800 },
  { name:"Regulatory Reporting Assistant", department:"Finance", owner:"Maya Thompson", productOwner:"Ethan Clark", stage:"Governance Review", risk:"High", aiType:"Generative AI", priority:"Critical", commercial:false, agents:3, model:"gpt-5.4-mini", monthlyBudget:4200 },
  { name:"Credit Risk Prediction", department:"Risk Management", owner:"Henry Walker", productOwner:"Zoe Harris", stage:"Initiative Review", risk:"Critical", aiType:"Predictive ML", priority:"Critical", commercial:true, agents:2, model:"gpt-5.6-luna", monthlyBudget:6500 },
  { name:"Fraud Investigation Agent", department:"Risk Management", owner:"Amelia Young", productOwner:"Lucas King", stage:"QA Deployment", risk:"High", aiType:"Agentic AI", priority:"Critical", commercial:false, agents:5, model:"gpt-5.4-mini", monthlyBudget:8300 },
  { name:"Internal Knowledge Assistant", department:"Technology", owner:"James Scott", productOwner:"Grace Green", stage:"Prod Deployment", risk:"Low", aiType:"Generative AI", priority:"Medium", commercial:false, agents:4, model:"gpt-4.1-mini", monthlyBudget:3600 },
  { name:"AI Document Intelligence", department:"Operations", owner:"Chloe Adams", productOwner:"Leo Baker", stage:"In Development", risk:"Medium", aiType:"Hybrid", priority:"Medium", commercial:true, agents:3, model:"gpt-5.6-luna", monthlyBudget:4800 },
  { name:"Portfolio Risk Monitoring", department:"Wealth Management", owner:"Mason Hall", productOwner:"Nora Rivera", stage:"Tech Review", risk:"High", aiType:"Hybrid", priority:"High", commercial:true, agents:6, model:"gpt-5.4-mini", monthlyBudget:7900 },
  { name:"Financial News Analysis Agent", department:"Investment Banking", owner:"Isla Wright", productOwner:"Owen Campbell", stage:"New", risk:"Low", aiType:"Generative AI", priority:"Medium", commercial:true, agents:2, model:"gpt-4.1-mini", monthlyBudget:2800 },
  { name:"Model Governance Assistant", department:"Compliance", owner:"Layla Mitchell", productOwner:"Jack Roberts", stage:"Governance Review", risk:"Medium", aiType:"Agentic AI", priority:"High", commercial:false, agents:4, model:"gpt-5.4-mini", monthlyBudget:3900 },
  { name:"Trade Surveillance AI", department:"Investment Banking", owner:"Samuel Turner", productOwner:"Emily Phillips", stage:"Retired", risk:"High", aiType:"Predictive ML", priority:"Low", commercial:false, agents:3, model:"gpt-5.6-luna", monthlyBudget:5200 },
];

function isoDay(offset: number): string {
  const date = new Date(Date.UTC(2026, 10, 2));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function usageFor(index: number): UsagePoint[] {
  return Array.from({ length: 90 }, (_, day) => {
    const activity = 42 + ((index * 19 + day * 13) % 118);
    const input = activity * (520 + index * 31);
    const output = activity * (170 + index * 17);
    const rate = index % 3 === 0 ? 0.0000021 : index % 3 === 1 ? 0.0000014 : 0.0000009;
    return { date: isoDay(day - 89), input_tokens: input, output_tokens: output, cost_usd: Number(((input + output) * rate).toFixed(4)), requests: activity };
  });
}

function agentsFor(seed: Seed, index: number, totalInput: number, totalOutput: number, totalCost: number): InitiativeAgent[] {
  return Array.from({ length: seed.agents }, (_, agentIndex) => ({
    agent_id: `AG-${String(index + 1).padStart(3, "0")}-${String(agentIndex + 1).padStart(2, "0")}`,
    name: `${seed.name.split(" ").slice(0, 3).join(" ")} ${["Coordinator", "Analyst", "Reviewer", "Monitor", "Assistant", "Orchestrator", "Validator", "Reporter"][agentIndex]}`,
    description: `Enterprise agent supporting ${seed.name.toLowerCase()} workflows.`,
    model: agentIndex % 3 === 0 ? seed.model : agentIndex % 3 === 1 ? "gpt-4.1-mini" : "gpt-5.4-mini",
    status: seed.stage === "Retired" ? "Inactive" : agentIndex === seed.agents - 1 && seed.stage !== "Prod Deployment" ? "Testing" : "Active",
    tools_count: 3 + ((index + agentIndex) % 8),
    mcp_connections: 1 + ((index + agentIndex) % 4),
    input_tokens: Math.round(totalInput / seed.agents * (0.82 + agentIndex * 0.05)),
    output_tokens: Math.round(totalOutput / seed.agents * (0.85 + agentIndex * 0.04)),
    total_cost: Number((totalCost / seed.agents * (0.84 + agentIndex * 0.04)).toFixed(2)),
    last_execution: `${isoDay(-((index + agentIndex) % 5))}T${String(9 + agentIndex).padStart(2, "0")}:30:00Z`,
  }));
}

function makeInitiative(seed: Seed, index: number): Initiative {
  const usage = usageFor(index);
  const totalInput = usage.reduce((sum, point) => sum + point.input_tokens, 0);
  const totalOutput = usage.reduce((sum, point) => sum + point.output_tokens, 0);
  const totalCost = Number(usage.reduce((sum, point) => sum + point.cost_usd, 0).toFixed(2));
  const month = usage.slice(-30);
  const monthlyCost = Number(month.reduce((sum, point) => sum + point.cost_usd, 0).toFixed(2));
  const requests = usage.reduce((sum, point) => sum + point.requests, 0);
  const stageIndex = LIFECYCLE_STAGES.indexOf(seed.stage);
  const created = `${isoDay(-220 + index * 7)}T09:00:00Z`;
  const history = LIFECYCLE_STAGES.slice(0, stageIndex + 1).map((stage, historyIndex) => ({
    id: `LH-${index}-${historyIndex}`,
    from_stage: historyIndex ? LIFECYCLE_STAGES[historyIndex - 1] : null,
    to_stage: stage,
    status: stage === "Retired" ? "Retired" as const : historyIndex === stageIndex ? (stage.includes("Review") ? "Pending Approval" as const : "In Progress" as const) : "Completed" as const,
    timestamp: `${isoDay(-200 + index * 5 + historyIndex * 11)}T14:15:00Z`,
    approver: historyIndex % 2 ? "AI Governance Office" : seed.owner,
    decision: historyIndex === stageIndex ? "Stage entered" : "Approved",
    comments: historyIndex === stageIndex ? "Current lifecycle stage." : "Entry criteria and supporting evidence reviewed.",
  }));
  const production = seed.stage === "Prod Deployment";
  const retired = seed.stage === "Retired";
  const agents = agentsFor(seed, index, totalInput, totalOutput, totalCost);
  const approval = (approval_type: "PTB" | "PTO" | "AI Governance", approved: boolean, reviewer: string, comments: string, rejected = false) => ({
    approval_type,
    status: rejected ? "Rejected" as const : approved ? "Approved" as const : "Pending" as const,
    approved_by: approved || rejected ? reviewer : null,
    approved_at: approved || rejected ? `${isoDay(-45 + index)}T14:30:00Z` : null,
    comments,
  });
  const approvals = [
    approval("PTB", stageIndex >= 1, seed.productOwner, stageIndex >= 1 ? "Business scope and funding reviewed." : "Awaiting product and business review."),
    approval("PTO", stageIndex >= 2 && index !== 7, ["William Thomas", "Harper Jackson", "Alexander White"][index % 3], index === 7 ? "Technical evidence requires rework." : stageIndex >= 2 ? "Technical architecture approved." : "Technical approval has not started.", index === 7),
    approval("AI Governance", stageIndex > 3, ["Ava Johnson", "Benjamin Moore", "Mia Anderson"][index % 3], stageIndex > 3 ? "Governance controls and evidence approved; regulatory compliance remains separately assessed." : "Governance decision is pending."),
  ];
  const accessList = [seed.owner, seed.productOwner, ["Ava Johnson", "Benjamin Moore", "Mia Anderson"][index % 3], ["William Thomas", "Harper Jackson", "Alexander White"][index % 3]].map((user_name, accessIndex) => ({ user_name, access_provided_at: `${isoDay(-170 + index * 4 + accessIndex * 8)}T09:15:00Z` }));

  return {
    initiative_id: `AI-INIT-${1024 + index}`,
    name: seed.name,
    description: `${seed.name} applies governed AI capabilities to improve decision quality, operational resilience, and customer outcomes across ${seed.department}.`,
    initiative_owner: seed.owner,
    product_owner: seed.productOwner,
    department_name: seed.department,
    business_unit: seed.department === "Technology" ? "Enterprise Platforms" : "Banking Services",
    commercial_use: seed.commercial,
    business_objective: `Modernize ${seed.department.toLowerCase()} workflows with measurable, controlled AI automation.`,
    use_case_category: seed.aiType === "Predictive ML" ? "Risk & Prediction" : "Knowledge & Workflow Automation",
    expected_business_value: `${12 + index * 3}% improvement in processing efficiency and stronger control evidence.`,
    priority: seed.priority,
    created_at: created,
    updated_at: `${isoDay(-(index % 12))}T16:20:00Z`,
    target_go_live_date: isoDay(35 + index * 4),
    current_state: seed.stage,
    stage_status: retired ? "Retired" : seed.stage.includes("Review") ? "Pending Approval" : production ? "Approved" : "In Progress",
    approval_status: seed.stage.includes("Review") ? "Pending" : retired || production ? "Approved" : "In Progress",
    governance_owner: ["Ava Johnson", "Benjamin Moore", "Mia Anderson"][index % 3],
    technical_owner: ["William Thomas", "Harper Jackson", "Alexander White"][index % 3],
    qa_owner: ["Evelyn Martin", "Michael Thompson", "Charlotte Garcia"][index % 3],
    deployment_date: production ? `${isoDay(-28 - index)}T10:00:00Z` : null,
    last_review_date: isoDay(-18 - index),
    next_review_date: isoDay(42 + index),
    number_of_agents: agents.length,
    ai_type: seed.aiType,
    model_providers: index % 4 === 0 ? ["OpenAI", "Azure"] : ["OpenAI"],
    models_used: Array.from(new Set(agents.map((agent) => agent.model))),
    mcp_servers: 1 + index % 5,
    tools_count: agents.reduce((sum, agent) => sum + agent.tools_count, 0),
    knowledge_sources: ["Policy Library", `${seed.department} Data Mart`, "Enterprise Knowledge Base"],
    vector_database: index % 2 ? "Azure AI Search" : "pgvector",
    deployment_environment: production ? "Production" : stageIndex >= 4 ? "QA" : "Development",
    human_in_the_loop: seed.risk !== "Low",
    total_token_cost: totalCost,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_tokens: totalInput + totalOutput,
    monthly_token_cost: monthlyCost,
    estimated_monthly_cost: Number((monthlyCost * (1.04 + index * 0.01)).toFixed(2)),
    total_llm_requests: requests,
    average_cost_per_request: Number((totalCost / requests).toFixed(4)),
    monthly_budget: seed.monthlyBudget,
    budget_utilization: Number(Math.min(99, monthlyCost / seed.monthlyBudget * 100).toFixed(1)),
    last_activity_at: `${isoDay(-(index % 4))}T18:10:00Z`,
    risk_level: seed.risk,
    data_classification: seed.risk === "Critical" ? "Highly Confidential" : seed.risk === "High" ? "Confidential" : "Internal",
    pii_processing: [1,2,5,7,8].includes(index),
    ai_governance_status: seed.stage === "Governance Review" ? "Pending" : stageIndex > 3 ? "Approved" : "In Progress",
    model_validation_status: stageIndex > 4 ? "Completed" : "In Progress",
    security_review_status: stageIndex > 3 ? "Approved" : "Pending",
    compliance_status: seed.risk === "Critical" ? "In Progress" : stageIndex > 3 ? "Approved" : "Pending",
    audit_status: production ? "Ready" : seed.risk === "Critical" ? "Needs Attention" : "Not Assessed",
    guardrails_enabled: seed.aiType !== "Predictive ML" || index % 2 === 0,
    explainability_required: seed.risk === "High" || seed.risk === "Critical",
    regulatory_frameworks: seed.commercial ? ["GDPR", "EU AI Act"] : ["Internal AI Policy", "EU AI Act"],
    eu_ai_act_risk_category: seed.risk === "Critical" ? "High Risk" : seed.risk === "High" ? "Limited Risk" : "Minimal Risk",
    human_oversight_required: seed.risk !== "Low",
    deployment_status: retired ? "Retired" : production ? "Production" : stageIndex >= 4 ? "QA" : "Development",
    availability_percentage: production ? Number((99.72 + index % 3 * 0.08).toFixed(2)) : 0,
    average_latency: production ? 620 + index * 37 : 0,
    error_rate: production ? Number((0.25 + index * 0.03).toFixed(2)) : 0,
    total_executions: requests,
    last_execution_time: `${isoDay(-(index % 4))}T18:10:00Z`,
    incident_count: production ? index % 3 : 0,
    monitoring_status: production ? "Enabled" : index % 3 === 0 ? "Enabled" : "Disabled",
    owner_contact: `${seed.owner.toLowerCase().replaceAll(" ", ".")}@delnbank.example`,
    cost_alert_threshold: seed.monthlyBudget * 0.85,
    usage,
    agents,
    lifecycle_history: history,
    deployments: [
      { environment:"Development", version:`1.${index}.0`, timestamp:`${isoDay(-80 + index)}T11:00:00Z`, approver:seed.productOwner, status:"Healthy" },
      { environment:"QA", version:`1.${index}.2`, timestamp:`${isoDay(-35 + index)}T13:00:00Z`, approver:["Evelyn Martin", "Michael Thompson"][index % 2], status:stageIndex >= 4 ? "Healthy" : "Not Deployed" },
      { environment:"Production", version:`1.${index}.3`, timestamp:`${isoDay(-20 + index)}T09:30:00Z`, approver:"Change Advisory Board", status:production ? "Healthy" : "Not Deployed" },
    ],
    audit_logs: [
      { id:`AU-${index}-1`, timestamp:`${isoDay(-2-index)}T15:00:00Z`, user:seed.productOwner, action:"Initiative updated", previous_value:"Architecture draft", updated_value:"Architecture reviewed", comments:"Technical evidence refreshed." },
      { id:`AU-${index}-2`, timestamp:`${isoDay(-10-index)}T10:30:00Z`, user:"AI Governance Office", action:"Risk assessment", previous_value:"Not assessed", updated_value:seed.risk, comments:"Risk classification recorded; this is not a compliance determination." },
    ],
    approvals,
    access_list: accessList,
  };
}

export const INITIAL_INITIATIVES: Initiative[] = seeds.map(makeInitiative);
