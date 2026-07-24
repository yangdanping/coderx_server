-- ============================================================
-- 008_create_content_ingest_pipeline.sql
--
-- 目的：为独立内容采集 Worker 建立来源、运行记录、候选池和文章来源归属。
--
-- 安全默认：
--   - 候选必须先进入 ingest_candidate，不直接写 article。
--   - canonical_url、source external id 和 content_hash 提供三层幂等保护。
--   - article_source 保留原文链接和转载许可，避免把聚合内容伪装成原创。
-- ============================================================

BEGIN;

CREATE TABLE ingest_source (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    feed_url TEXT NOT NULL,
    homepage_url TEXT NOT NULL,
    feed_type TEXT NOT NULL DEFAULT 'rss'
        CHECK (feed_type IN ('rss', 'atom')),
    content_mode TEXT NOT NULL DEFAULT 'summary'
        CHECK (content_mode IN ('summary', 'full')),
    license_code TEXT NOT NULL DEFAULT 'link-only',
    daily_limit INTEGER NOT NULL DEFAULT 2
        CHECK (daily_limit BETWEEN 1 AND 20),
    trust_score INTEGER NOT NULL DEFAULT 15
        CHECK (trust_score BETWEEN 0 AND 20),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ingest_run (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trigger_type TEXT NOT NULL
        CHECK (trigger_type IN ('manual', 'scheduled')),
    run_mode TEXT NOT NULL
        CHECK (run_mode IN ('collect', 'enrich', 'publish', 'full')),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
    stats JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(stats) = 'object'),
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT ingest_run_finished_at_check
        CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE ingest_candidate (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id BIGINT NOT NULL
        REFERENCES ingest_source(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    run_id BIGINT
        REFERENCES ingest_run(id) ON DELETE SET NULL,
    article_id BIGINT UNIQUE
        REFERENCES article(id) ON DELETE SET NULL,
    external_id TEXT,
    canonical_url TEXT NOT NULL UNIQUE,
    title_original TEXT NOT NULL,
    title_zh TEXT,
    summary_original TEXT,
    summary_zh TEXT,
    recommendation TEXT,
    author_original TEXT,
    source_published_at TIMESTAMPTZ,
    content_mode TEXT NOT NULL DEFAULT 'summary'
        CHECK (content_mode IN ('summary', 'full')),
    license_code TEXT NOT NULL DEFAULT 'link-only',
    content JSONB
        CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(raw_payload) = 'object'),
    content_hash TEXT,
    score INTEGER NOT NULL DEFAULT 0
        CHECK (score BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'enriched', 'approved', 'rejected', 'published', 'failed')),
    failure_reason TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE article_source (
    article_id BIGINT PRIMARY KEY
        REFERENCES article(id) ON DELETE CASCADE,
    candidate_id BIGINT UNIQUE
        REFERENCES ingest_candidate(id) ON DELETE SET NULL,
    source_id BIGINT NOT NULL
        REFERENCES ingest_source(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    canonical_url TEXT NOT NULL UNIQUE,
    source_title TEXT NOT NULL,
    source_published_at TIMESTAMPTZ,
    content_mode TEXT NOT NULL DEFAULT 'summary'
        CHECK (content_mode IN ('summary', 'full')),
    license_code TEXT NOT NULL DEFAULT 'link-only',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX ingest_candidate_source_external_id_uidx
    ON ingest_candidate (source_id, external_id)
    WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX ingest_candidate_content_hash_uidx
    ON ingest_candidate (content_hash)
    WHERE content_hash IS NOT NULL;

CREATE INDEX ingest_run_started_at_idx
    ON ingest_run (started_at DESC);

CREATE INDEX ingest_candidate_source_id_idx
    ON ingest_candidate (source_id);

CREATE INDEX ingest_candidate_run_id_idx
    ON ingest_candidate (run_id);

CREATE INDEX ingest_candidate_review_idx
    ON ingest_candidate (status, score DESC, source_published_at DESC);

CREATE INDEX article_source_source_id_idx
    ON article_source (source_id);

COMMENT ON TABLE ingest_source IS '独立内容采集 Worker 的公开 Feed 来源配置';
COMMENT ON TABLE ingest_run IS '采集、中文化和发布任务的审计记录';
COMMENT ON TABLE ingest_candidate IS '正式发布前的幂等候选池';
COMMENT ON TABLE article_source IS '聚合文章与第三方原文来源的一对一归属';
COMMENT ON COLUMN ingest_source.license_code IS 'link-only 表示仅保存摘要和原文链接';
COMMENT ON COLUMN ingest_candidate.content IS '符合 CoderX Tiptap JSON 契约的待发布正文';

COMMIT;
