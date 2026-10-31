CREATE TABLE IF NOT EXISTS agent_chat_interactions (
    agent_chat_interaction_id CHAR(36) NOT NULL,
    agent_id CHAR(36) NOT NULL,
    input_payload JSON NOT NULL,
    output_payload JSON NOT NULL,
    input_token_count BIGINT UNSIGNED NOT NULL,
    output_token_count BIGINT UNSIGNED NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(320) NOT NULL,
    session_id VARCHAR(255) NOT NULL,
    chat_sequence_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (agent_chat_interaction_id),
    CONSTRAINT uq_agent_chat_interactions_sequence
        UNIQUE (agent_id, session_id, chat_sequence_id),
    INDEX idx_agent_chat_interactions_user_id (user_id),
    INDEX idx_agent_chat_interactions_model_id (model_id),
    INDEX idx_agent_chat_interactions_session_id (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
