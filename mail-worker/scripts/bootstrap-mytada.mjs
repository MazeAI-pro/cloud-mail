import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
const password = process.env.MYTADA_ADMIN_PASSWORD;
if (!output || !password || password.length < 20 || password.length > 30) {
  throw new Error('Provide a fresh MYTADA_ADMIN_PASSWORD (20–30 characters) and an unused output directory');
}
const temp = await mkdtemp(join(tmpdir(), 'mytada-bootstrap-'));
const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['db'] });
try {
  const bundlePath = join(temp, 'init.mjs');
  await build({ stdin: {
    contents: `export { dbInit } from './src/init/init.js'; export { default as cryptoUtils } from './src/utils/crypto-utils.js'; export { default as settingService } from './src/service/setting-service.js';`,
    resolveDir: root,
  }, bundle: true, platform: 'node', format: 'esm', outfile: bundlePath, logLevel: 'silent', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  const { dbInit, cryptoUtils, settingService } = await import(pathToFileURL(bundlePath));
  const db = await runtime.getD1Database('db');
  const values = new Map();
  const kv = new Map();
  const context = { env: { db, jwt_secret: 'local-only-schema-generation', kv: { put: async (key, value) => kv.set(key, value) } },
    req: { param: () => 'local-only-schema-generation' }, text: value => value,
    set: (key, value) => values.set(key, value), get: key => values.get(key) };
  // This runs only against a fresh ephemeral local database, never a remote binding.
  await dbInit.init(context);
  await db.prepare("UPDATE setting SET register = 1, reg_key = 0, send = 1, title = 'Tada Mail', no_recipient = 1").run();
  const { salt, hash } = await cryptoUtils.hashPassword(password);
  await db.batch([
    db.prepare("INSERT INTO user(email,password,salt,type) VALUES ('admin@mytada.ai',?,?,1)").bind(hash, salt),
    db.prepare("INSERT INTO account(email,name,user_id) VALUES ('admin@mytada.ai','admin',(SELECT user_id FROM user WHERE email='admin@mytada.ai'))"),
  ]);
  await settingService.refresh(context);
  const quote = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  const identifier = value => `"${value.replaceAll('"', '""')}"`;
  const { results: objects } = await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC,name").all();
  const lines = ['-- Fresh mytada database only. Contains an administrator password hash.'];
  for (const object of objects.filter(item => item.type === 'table')) {
    // CREATE without IF NOT EXISTS ensures an existing target cannot be silently overwritten.
    lines.push(object.sql.replace(/IF NOT EXISTS\s+/i, '') + ';');
    const { results: rows } = await db.prepare(`SELECT * FROM ${identifier(object.name)}`).all();
    for (const row of rows) lines.push(`INSERT INTO ${identifier(object.name)} (${Object.keys(row).map(identifier).join(',')}) VALUES (${Object.values(row).map(quote).join(',')});`);
  }
  for (const object of objects.filter(item => item.type !== 'table')) lines.push(object.sql + ';');
  await mkdir(resolve(output), { mode: 0o700 });
  await writeFile(resolve(output, 'bootstrap.sql'), lines.join('\n') + '\n', { mode: 0o600 });
  await writeFile(resolve(output, 'kv-bootstrap.json'), JSON.stringify([
    { key: 'setting:', value: kv.get('setting:') },
    { key: 'deployment:ready', value: 'mytada-v1' },
  ]), { mode: 0o600 });
  await writeFile(resolve(output, 'r2-ready.txt'), 'mytada-v1\n', { mode: 0o600 });
  console.log('Generated bootstrap.sql, kv-bootstrap.json and r2-ready.txt. No remote changes made.');
} finally {
  await runtime.dispose();
  await rm(temp, { recursive: true, force: true });
}
