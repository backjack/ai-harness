CREATE TABLE IF NOT EXISTS agents (
    agent_id CHAR(36) NOT NULL,
    agent_name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    initiative_id VARCHAR(255) NULL,
    faq JSON NULL,
    owner_email VARCHAR(320) NOT NULL,
    shared_with JSON,
    model_id VARCHAR(255) NOT NULL,
    tooling JSON NOT NULL,
    system_prompts JSON,
    user_prompts JSON,
    model_type VARCHAR(100) NOT NULL,
    guardrails JSON,
    isActive CHAR(1) NOT NULL DEFAULT 'Y',
    last_updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    created_by VARCHAR(320) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (agent_id),
    INDEX idx_agents_owner_email (owner_email),
    INDEX idx_agents_model_id (model_id),
    INDEX idx_agents_is_active (isActive)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
