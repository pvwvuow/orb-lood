// Idempotent schema migrations, shared by `npm run init-db` and server boot.
//
// schema.sql only creates tables that don't exist yet. Everything that was
// added later lives here, so a database created from an old schema.sql (or
// by docker's init script) is brought up to date automatically.
//
// `db` is anything with a mysql2-style `query(sql, params) -> [rows]`
// (a pool or a single connection).

const COLUMNS = [
  ['text_channels',     'visible_role_ids', 'JSON NULL'],
  ['voice_channels',    'visible_role_ids', 'JSON NULL'],
  ['server_categories', 'visible_role_ids', 'JSON NULL'],
  // Per-role allow / deny lists: { role_id: ["sendMessages", ...] }.
  ['text_channels',     'permission_allow', 'JSON NULL'],
  ['text_channels',     'permission_deny',  'JSON NULL'],
  ['voice_channels',    'permission_allow', 'JSON NULL'],
  ['voice_channels',    'permission_deny',  'JSON NULL'],
  // Customization packs.
  ['users',             'unlocked_packs',   'JSON NULL'],
  ['servers',           'style_name',       'VARCHAR(40) NULL'],
  ['servers',           'style_pin',        'VARCHAR(40) NULL'],
  ['servers',           'style_cover',      'VARCHAR(40) NULL'],
  ['servers',           'style_emblem',     'VARCHAR(40) NULL'],
  ['server_categories', 'custom_style',     'VARCHAR(40) NULL'],
  ['text_channels',     'custom_style',     'VARCHAR(40) NULL'],
  ['voice_channels',    'custom_style',     'VARCHAR(40) NULL'],
  // Voice bitrate (Opus kbps), NULL = 64.
  ['voice_channels',    'bitrate',          'INT NULL'],
  // Bumped on password change: invalidates every older login token.
  ['users',             'token_version',    'INT NOT NULL DEFAULT 0'],
];

const INDEXES = [
  // "which voice channel is this user in" (signaling relay, eviction).
  ['voice_channel_members', 'idx_vcm_user', '(user_id)'],
  ['auth_tokens',           'idx_auth_exp', '(expires_at)'],
];

const LOOKALIKE_SQL = col =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col}, '<', '\u2039'), '>', '\u203A'), '"', '\u201D'), '''', '\u2019'), '\`', '\u02CB')`;

const NAME_COLUMNS = [
  ['users', 'name'], ['servers', 'name'], ['servers', 'initial'], ['servers', 'description'],
  ['server_categories', 'name'], ['text_channels', 'name'],
  ['voice_channels', 'name'], ['server_roles', 'name'], ['users', 'bio']
];

const IMAGE_COLUMNS = [
  ['users', 'av_image'], ['users', 'banner_image'],
  ['servers', 'cover'], ['servers', 'emblem_image']
];

async function dbName(db) {
  const [rows] = await db.query('SELECT DATABASE() AS d');
  return rows[0].d;
}

export async function runMigrations(db, log = console.log) {
  const schema = await dbName(db);
  const [tables] = await db.query(
    'SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?', [schema]);
  const have = new Set(tables.map(r => r.t));

  for (const [table, column, def] of COLUMNS) {
    if (!have.has(table)) continue;
    const [rows] = await db.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [schema, table, column]);
    if (Number(rows[0].n) === 0) {
      await db.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + def);
      log('[migrate] added ' + table + '.' + column);
    }
  }

  for (const [table, name, cols] of INDEXES) {
    if (!have.has(table)) continue;
    const [rows] = await db.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [schema, table, name]);
    if (Number(rows[0].n) === 0) {
      await db.query('ALTER TABLE `' + table + '` ADD INDEX `' + name + '` ' + cols);
      log('[migrate] added index ' + table + '.' + name);
    }
  }

  // One-shot data migrations, tracked in schema_migrations.
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(80) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const once = async (id, fn) => {
    const [done] = await db.query('SELECT 1 FROM schema_migrations WHERE id = ?', [id]);
    if (done.length) return;
    await fn();
    await db.query('INSERT IGNORE INTO schema_migrations (id) VALUES (?)', [id]);
    log('[migrate] applied ' + id);
  };

  // Stored-XSS clean-up: names saved before the server started sanitising
  // them may still contain markup.
  await once('2026-10-15-sanitize-names', async () => {
    for (const [table, col] of NAME_COLUMNS) {
      if (!have.has(table)) continue;
      await db.query(
        'UPDATE `' + table + '` SET `' + col + '` = ' + LOOKALIKE_SQL('`' + col + '`') +
        " WHERE `" + col + "` REGEXP '[<>\"''`]'");
    }
  });

  // Unsafe image URLs (javascript:, svg data URLs, quote breakouts) -> NULL.
  await once('2026-10-15-sanitize-images', async () => {
    for (const [table, col] of IMAGE_COLUMNS) {
      if (!have.has(table)) continue;
      const c = '`' + col + '`';
      await db.query(
        'UPDATE `' + table + '` SET ' + c + ' = NULL WHERE ' + c + " IS NOT NULL AND " + c + " <> '' AND (" +
        c + " REGEXP '[\"<>`]' OR NOT (" +
          c + " LIKE '/%' OR " + c + " LIKE 'http://%' OR " + c + " LIKE 'https://%' OR " +
          c + " LIKE 'data:image/png;%' OR " + c + " LIKE 'data:image/jpeg;%' OR " +
          c + " LIKE 'data:image/jpg;%' OR " + c + " LIKE 'data:image/gif;%' OR " +
          c + " LIKE 'data:image/webp;%'))");
    }
  });

  // Housekeeping: expired logout revocations.
  if (have.has('auth_tokens')) {
    await db.query('DELETE FROM auth_tokens WHERE expires_at < CURRENT_TIMESTAMP');
  }
}
