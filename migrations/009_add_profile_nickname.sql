-- ============================================================
-- 009_add_profile_nickname.sql
--
-- 目的：增加可选、可重名的用户展示昵称；账号名继续由 "user".name 承担。
-- ============================================================

BEGIN;

ALTER TABLE profile
    ADD COLUMN nickname TEXT,
    ADD CONSTRAINT profile_nickname_check CHECK (
        nickname IS NULL
        OR (
            nickname = btrim(nickname)
            AND length(nickname) BETWEEN 1 AND 30
            AND nickname !~ '[[:cntrl:]]'
            AND position(U&'\2028' IN nickname) = 0
            AND position(U&'\2029' IN nickname) = 0
        )
    );

COMMENT ON COLUMN profile.nickname IS '用户自定义昵称，可为空且允许重名';

COMMIT;
