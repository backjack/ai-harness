SET @description_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'agents'
      AND COLUMN_NAME = 'description'
);

SET @description_sql = IF(
    @description_exists = 0,
    'ALTER TABLE agents ADD COLUMN description TEXT NULL AFTER agent_name',
    'SELECT 1'
);

PREPARE description_statement FROM @description_sql;
EXECUTE description_statement;
DEALLOCATE PREPARE description_statement;
