ALTER TABLE agents
    ADD COLUMN description TEXT NOT NULL DEFAULT '' AFTER agent_name,
    ADD COLUMN workflow TEXT NOT NULL DEFAULT '' AFTER description;
