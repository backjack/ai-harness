CREATE TABLE IF NOT EXISTS admin_users (
    emailid VARCHAR(320) NOT NULL,
    firstname VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (emailid),
    INDEX idx_admin_users_is_admin (is_admin),
    INDEX idx_admin_users_is_disabled (is_disabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO admin_users (emailid, firstname, last_name, is_admin, is_disabled)
VALUES ('neeraj.s1988@gmail.com', 'Neeraj', 'Sharma', TRUE, FALSE)
ON DUPLICATE KEY UPDATE emailid = VALUES(emailid);
