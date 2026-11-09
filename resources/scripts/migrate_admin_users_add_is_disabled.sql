-- One-time migration from allowlist access to an enabled-by-default user registry.
-- Existing users remain enabled.

ALTER TABLE admin_users
    ADD COLUMN is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD INDEX idx_admin_users_is_disabled (is_disabled);
