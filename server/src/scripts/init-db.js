// One-shot helper: creates the database schema if it doesn't exist yet and
// applies every migration. Safe to re-run. `npm run init-db`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { runMigrations } from '../lib/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '..', 'schema.sql');

(async () => {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  // Connect WITHOUT a database first, so we can CREATE DATABASE if missing.
  const root = await mysql.createConnection({
    host: config.db.host, port: config.db.port,
    user: config.db.user, password: config.db.password,
    multipleStatements: true,
    charset: 'utf8mb4'
  });
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.query(`USE \`${config.db.database}\``);
  await root.query(sql);

  // Migrate server_roles primary key from (id) to (server_id, id) so the
  // role id stays unique only within a server. Detect the old shape and
  // rebuild. (SEQ_IN_INDEX works on both MySQL and MariaDB.)
  const [pkRows] = await root.query(
    `SELECT COLUMN_NAME, SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'server_roles' AND INDEX_NAME = 'PRIMARY'
      ORDER BY SEQ_IN_INDEX`,
    [config.db.database]);
  const pkCols = pkRows.map(r => r.COLUMN_NAME);
  if (pkCols.length === 1 && pkCols[0] === 'id'){
    console.log('[init-db] migrating server_roles primary key to (server_id, id)');
    await root.query('SET FOREIGN_KEY_CHECKS = 0');
    const [fks] = await root.query(
      `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'server_role_members' AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
      [config.db.database]);
    for (const fk of fks){
      await root.query('ALTER TABLE `server_role_members` DROP FOREIGN KEY `' + fk.CONSTRAINT_NAME + '`');
    }
    const [srmCols] = await root.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'server_role_members'`,
      [config.db.database]);
    const srmHasServer = srmCols.some(c => c.COLUMN_NAME === 'server_id');
    if (!srmHasServer){
      await root.query('ALTER TABLE `server_role_members` ADD COLUMN `server_id` VARCHAR(40) NULL FIRST');
      await root.query(`UPDATE server_role_members srm
        JOIN server_roles sr ON sr.id = srm.role_id
        SET srm.server_id = sr.server_id`);
      await root.query('ALTER TABLE `server_role_members` MODIFY `server_id` VARCHAR(40) NOT NULL');
    }
    await root.query('ALTER TABLE `server_role_members` DROP PRIMARY KEY, ADD PRIMARY KEY (`server_id`, `role_id`, `user_id`)');
    await root.query('ALTER TABLE `server_roles` DROP PRIMARY KEY, ADD PRIMARY KEY (`server_id`, `id`)');
    await root.query(`ALTER TABLE \`server_role_members\`
      ADD CONSTRAINT \`fk_srm_role\` FOREIGN KEY (\`server_id\`, \`role_id\`)
      REFERENCES \`server_roles\` (\`server_id\`, \`id\`) ON DELETE CASCADE`);
    await root.query(`ALTER TABLE \`server_role_members\`
      ADD CONSTRAINT \`fk_srm_user\` FOREIGN KEY (\`user_id\`)
      REFERENCES \`users\` (\`id\`) ON DELETE CASCADE`);
    await root.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('[init-db] server_roles migration done');
  }

  // Columns / indexes / data clean-ups added after the initial schema.
  await runMigrations(root, msg => console.log(msg.replace('[migrate]', '[init-db]')));

  await root.end();
  console.log(`[init-db] schema applied to ${config.db.database}`);
  process.exit(0);
})().catch(e => {
  console.error('[init-db] failed:', e);
  process.exit(1);
});
