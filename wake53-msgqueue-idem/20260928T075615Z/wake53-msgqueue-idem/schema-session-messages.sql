CREATE TABLE messages (
      message_id TEXT PRIMARY KEY,
      sender_host TEXT NOT NULL,
      sender_session_id TEXT NOT NULL,
      target_host TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      body TEXT NOT NULL,
      body_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      claim_until TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      first_delivered_at TEXT,
      acknowledged_at TEXT
    ) STRICT;

CREATE INDEX messages_target_pending
      ON messages (target_host, target_session_id, acknowledged_at, expires_at, claim_until);

CREATE TABLE relay_leases (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      relay_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      parent_pid INTEGER NOT NULL,
      lease_until TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, session_id, transport)
    ) STRICT;

CREATE TABLE wake_nonces (
      nonce_digest TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    , state TEXT NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy', 'reserved', 'started', 'submitted', 'unknown', 'observed', 'not-submitted')), nonce TEXT, instance_id TEXT, birth_generation TEXT, transport TEXT, relay_id TEXT, attempt_id TEXT, dispatch_epoch INTEGER NOT NULL DEFAULT 0, retry_not_before TEXT, retry_count INTEGER NOT NULL DEFAULT 0, started_at TEXT, outcome_at TEXT, observed_at TEXT, late_observed_at TEXT) STRICT;

CREATE TABLE session_presence (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      wake_visibility TEXT NOT NULL CHECK (wake_visibility IN ('silent', 'user-message', 'none')),
      can_wake_silently INTEGER NOT NULL CHECK (can_wake_silently IN (0, 1)),
      supported_injection TEXT NOT NULL DEFAULT '[]',
      idle_wake TEXT NOT NULL DEFAULT 'none' CHECK (idle_wake IN ('silent', 'user-message', 'none')),
      collaboration_id TEXT,
      workspace_id TEXT,
      role TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_until TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      PRIMARY KEY (host, session_id, instance_id)
    ) STRICT;

CREATE INDEX session_presence_latest
      ON session_presence (host, session_id, started_at DESC);

CREATE TABLE prepared_messages (
        message_id TEXT PRIMARY KEY,
        sender_host TEXT NOT NULL,
        sender_session_id TEXT NOT NULL,
        target_host TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        body TEXT,
        ttl_seconds INTEGER NOT NULL,
        prepared_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        receipt TEXT,
        record_bytes INTEGER NOT NULL
      ) STRICT;

CREATE INDEX prepared_messages_expiry ON prepared_messages (expires_at);

CREATE INDEX prepared_messages_owner ON prepared_messages (sender_host, sender_session_id, receipt);

CREATE TABLE input_observations (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        deferred_tool_claim INTEGER NOT NULL DEFAULT 0 CHECK (deferred_tool_claim IN (0, 1)),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id)
      ) STRICT;

CREATE UNIQUE INDEX wake_active_target ON wake_nonces (host, session_id)
        WHERE state IN ('reserved', 'started', 'submitted', 'unknown');