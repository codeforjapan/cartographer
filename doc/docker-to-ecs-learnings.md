# Docker 開発環境 → ECS デプロイ: 学びと注意点

ローカル Docker 開発環境の構築で発見した問題と、ECS Fargate + EFS 環境での対応策をまとめる。

## 1. Project M36 の `createDirectory` 問題

### ローカルで起きたこと

```
cartographer-backend: /app/.m36-data: createDirectory: already exists (File exists)
```

Docker ボリュームのマウントポイント (`/app/.m36-data`) が事前にディレクトリとして作成されるため、
Project M36 の `CrashSafePersistence` が内部で `createDirectory` を実行すると「既に存在する」エラーになった。

### 解決策（ローカル）

ボリュームのマウントポイントと M36 のデータパスを分離した:

```yaml
# docker-compose.yml
volumes:
  - m36data:/app/m36-volume     # マウントポイント
environment:
  M36_DATA_PATH: /app/m36-volume/data  # M36 がこのサブディレクトリを createDirectory する
```

### ECS + EFS での対応

CDK の `backend-stack.ts` でも同じ構造にする必要がある。

```typescript
// コンテナのマウントポイント
container.addMountPoints({
  containerPath: "/app/m36-volume",   // EFS マウント先
  sourceVolume: "m36-data",
  readOnly: false,
});

// 環境変数はサブディレクトリを指定
environment: {
  M36_DATA_PATH: "/app/m36-volume/data",  // M36 が作成するパス
}
```

**重要**: EFS Access Point の `path` (`/m36-data`) は EFS 上のルートパス。
コンテナ内の `containerPath` は EFS とは無関係のローカルパスなので混同しないこと。

---

## 2. ボリュームの権限 (UID/GID) 問題

### ローカルで起きたこと

```
cartographer-backend: /app/m36-volume/data: createDirectory: permission denied (Permission denied)
```

Docker ボリュームは root:root で作成されるが、コンテナは UID 1000 の `app` ユーザーで動作するため書き込めない。

### 解決策（ローカル）

entrypoint スクリプトで root として `chown` してからアプリユーザーに切り替え:

```dockerfile
COPY --chmod=755 <<'EOF' /entrypoint.sh
#!/bin/sh
set -e
chown -R app:app /app/m36-volume
exec su -s /bin/sh app -c 'exec cartographer-backend'
EOF
ENTRYPOINT ["/entrypoint.sh"]
```

**注意**: root ユーザーは `[ ! -w dir ]` チェックを常にパスするため、
`-w` による条件分岐は意味がない。無条件に `chown` を実行すること。

### ECS + EFS での対応

EFS Access Point で POSIX ユーザーを設定済み（CDK の `backend-stack.ts`）:

```typescript
const accessPoint = fileSystem.addAccessPoint("M36AccessPoint", {
  path: "/m36-data",
  createAcl: {
    ownerGid: "1000",
    ownerUid: "1000",
    permissions: "755",
  },
  posixUser: {
    gid: "1000",
    uid: "1000",
  },
});
```

- EFS Access Point が UID/GID 1000 を強制するため、ECS 側では **entrypoint での chown は不要**
- ただし、Dockerfile の `app` ユーザーの UID/GID が **1000 であること** を確認すること
- もし一致しないと書き込み権限エラーが再発する

---

## 3. PostgreSQL ロール不在 (Supabase マイグレーション)

### ローカルで起きたこと

```
ERROR: role "anon" does not exist
ERROR: role "authenticated" does not exist
ERROR: role "service_role" does not exist
```

Supabase のマイグレーション SQL が `GRANT ... TO anon/authenticated/service_role` を含むが、
素の PostgreSQL にはこれらのロールが存在しない。

### 解決策（ローカル）

DB 初期化時に Supabase 互換ロールを作成するスクリプトを追加:

```sql
-- infra/docker/init-supabase-roles.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  -- authenticated, service_role も同様
END $$;
```

### ECS での対応

- **Supabase Cloud を使う場合**: これらのロールは自動的に存在するため対応不要
- **RDS を使う場合**: RDS の初期化スクリプトまたはマイグレーション手順の最初にロール作成を入れること

---

## 4. CDK 修正チェックリスト

現在の `backend-stack.ts` に対して、上記の学びを反映する際の確認事項:

- [ ] `M36_DATA_PATH` がマウントポイントの **サブディレクトリ** を指していること
  - 現状: `M36_DATA_PATH: "/app/.m36-data"` + `containerPath: "/app/.m36-data"` → **同じパスで問題あり**
  - 修正: `containerPath: "/app/m36-volume"` + `M36_DATA_PATH: "/app/m36-volume/data"`
- [ ] Dockerfile の `app` ユーザーが UID/GID 1000 であること（EFS Access Point と一致）
- [ ] Dockerfile の entrypoint が `chown` + `su` パターンを使っていること（EFS では不要だがローカルとの互換性のため）
- [ ] ヘルスチェックの `start-period` が十分であること（M36 スキーママイグレーションに時間がかかる場合がある）

---

## 5. ローカル ↔ ECS の環境差異まとめ

| 項目 | ローカル (docker-compose) | ECS Fargate + EFS |
|------|--------------------------|-------------------|
| ストレージ | Docker named volume | EFS + Access Point |
| 権限制御 | entrypoint で chown | EFS Access Point の POSIX 設定 |
| DB | PostgreSQL コンテナ | Supabase Cloud (または RDS) |
| Supabase ロール | 手動作成が必要 | 自動で存在 |
| M36 パス | `/app/m36-volume/data` | `/app/m36-volume/data` (統一) |
| ネットワーク | Docker network | VPC Private Subnet |
