import { createRequire } from 'node:module';

// Resolve the already installed Wrangler runtime without adding dependencies.
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))('miniflare');

export async function createLocalD1() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['db'],
  });
  return { db: await runtime.getD1Database('db'), dispose: () => runtime.dispose() };
}
