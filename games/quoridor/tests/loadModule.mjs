import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from '../node_modules/esbuild/lib/main.js';

/** Load the real TypeScript module without keeping a test-only copy. */
export async function loadModule(url) {
  const result = await build({
    entryPoints: [fileURLToPath(url)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(
    module,
    module.exports,
    createRequire(url),
  );
  return module.exports;
}
