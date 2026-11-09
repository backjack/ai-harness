-- Share every existing active agent with the trusted static deployment user.
-- Safe to run repeatedly: JSON_CONTAINS prevents duplicate email entries.

UPDATE agents
SET shared_with = CASE
    WHEN JSON_CONTAINS(
        COALESCE(shared_with, JSON_ARRAY()),
        JSON_QUOTE('neeraj.s1988@gmail.com')
    ) THEN COALESCE(shared_with, JSON_ARRAY())
    ELSE JSON_ARRAY_APPEND(
        COALESCE(shared_with, JSON_ARRAY()),
        '$',
        'neeraj.s1988@gmail.com'
    )
END
WHERE isActive = 'Y';
