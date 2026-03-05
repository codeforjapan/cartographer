-- Supabase 互換ロールを作成する
-- マイグレーション SQL が GRANT 文でこれらのロールを参照するため必要
-- PostgREST が authenticator ロール経由でこれらのロールに切り替える

-- authenticator: PostgREST がDB接続に使用するログイン可能ロール
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'postgres';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- authenticator が各ロールに SET ROLE できるようにする
GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;

-- スキーマへのアクセス権
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- realtime スキーマのスタブ (Docker ローカル開発用)
-- Supabase の realtime サービスが提供する broadcast_changes 関数を
-- ダミーで作成し、トリガーエラーを回避する
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS realtime;

CREATE OR REPLACE FUNCTION realtime.broadcast_changes(
  topic text,
  event text,
  operation text,
  table_name text,
  table_schema text,
  new_record record,
  old_record record
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- no-op: realtime service is not available in Docker dev environment
  NULL;
END;
$$;

-- デフォルト権限: 今後作成されるテーブルにも自動で権限付与
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
