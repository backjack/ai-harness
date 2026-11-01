-- One-time migration for the soft-delete APIs.
-- Existing rows remain active because each column is added with DEFAULT 'Y'.

ALTER TABLE agents
    ADD COLUMN isActive CHAR(1) NOT NULL DEFAULT 'Y',
    ADD INDEX idx_agents_is_active (isActive);

ALTER TABLE tool_sources
    ADD COLUMN isActive CHAR(1) NOT NULL DEFAULT 'Y',
    ADD INDEX idx_tool_sources_is_active (isActive);

ALTER TABLE tool_definitions
    ADD COLUMN isActive CHAR(1) NOT NULL DEFAULT 'Y',
    ADD INDEX idx_tool_definitions_is_active (isActive);
