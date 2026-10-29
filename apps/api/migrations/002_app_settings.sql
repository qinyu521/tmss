-- 本机运行期设置（AI 史官等）。单机部署下与 SQLite 同卷保存，不对外暴露密钥。
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
