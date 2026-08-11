BEGIN;

CREATE TABLE flow_post (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES "user"(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    client_request_id UUID NOT NULL,
    content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    body_text TEXT NOT NULL CHECK (char_length(body_text) <= 2000),
    create_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    update_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT flow_post_user_request_uidx UNIQUE (user_id, client_request_id)
);

CREATE INDEX flow_post_feed_idx ON flow_post (create_at DESC, id DESC);
CREATE INDEX flow_post_user_idx ON flow_post (user_id, create_at DESC, id DESC);

CREATE TABLE flow_post_media (
    flow_id BIGINT NOT NULL REFERENCES flow_post(id) ON DELETE CASCADE,
    file_id BIGINT NOT NULL UNIQUE REFERENCES file(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 8),
    alt_text TEXT NOT NULL DEFAULT '' CHECK (char_length(alt_text) <= 200),
    PRIMARY KEY (flow_id, file_id),
    CONSTRAINT flow_post_media_position_uidx UNIQUE (flow_id, position)
);

CREATE INDEX flow_post_media_flow_idx ON flow_post_media (flow_id, position);
CREATE INDEX draft_consumed_article_id_idx ON draft (consumed_article_id) WHERE consumed_article_id IS NOT NULL;

COMMIT;
