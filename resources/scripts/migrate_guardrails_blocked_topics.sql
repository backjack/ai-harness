-- Convert the legacy "Topics on <topic>" response format into a real blocked topic.
-- Other response-only configurations are intentionally not guessed or rewritten.

UPDATE agents
SET guardrails = JSON_SET(
    guardrails,
    '$.blocked_topics', JSON_ARRAY(
        TRIM(SUBSTRING(
            JSON_UNQUOTE(JSON_EXTRACT(guardrails, '$.out_of_scope_response')),
            CHAR_LENGTH('Topics on ') + 1
        ))
    ),
    '$.out_of_scope_response', 'This request is outside the agent''s configured scope.'
)
WHERE JSON_UNQUOTE(JSON_EXTRACT(guardrails, '$.out_of_scope_response')) LIKE 'Topics on %'
  AND TRIM(SUBSTRING(
      JSON_UNQUOTE(JSON_EXTRACT(guardrails, '$.out_of_scope_response')),
      CHAR_LENGTH('Topics on ') + 1
  )) <> ''
  AND JSON_EXTRACT(guardrails, '$.policy_text') IS NULL
  AND JSON_EXTRACT(guardrails, '$.allowed_topics') IS NULL
  AND JSON_EXTRACT(guardrails, '$.blocked_topics') IS NULL;
