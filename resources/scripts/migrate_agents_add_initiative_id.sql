SET @initiative_id_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'agents'
      AND COLUMN_NAME = 'initiative_id'
);

SET @initiative_id_sql = IF(
    @initiative_id_exists = 0,
    'ALTER TABLE agents ADD COLUMN initiative_id VARCHAR(255) NULL AFTER description',
    'SELECT 1'
);

PREPARE initiative_id_statement FROM @initiative_id_sql;
EXECUTE initiative_id_statement;
DEALLOCATE PREPARE initiative_id_statement;
