import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = path.join(root, 'crates', 'tg-wasm');
const outDir = path.join(root, 'apps', 'web', 'src', 'wasm-pkg');

mkdirSync(outDir, { recursive: true });

const wasmPackCmd = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'wasm-pack.cmd')
  : path.join(root, 'node_modules', '.bin', 'wasm-pack');

const bin = existsSync(wasmPackCmd) ? `"${wasmPackCmd}"` : 'wasm-pack';
const args = process.argv.includes('--dev') ? '--dev' : '--release';

console.log(`[build-wasm] Compiling tg-wasm (${args}) -> ${outDir}`);
execSync(`${bin} build "${crateDir}" --target web --out-dir "${outDir}" ${args} --no-opt`, {
  cwd: root,
  stdio: 'inherit'
});

// Remove generated .gitignore so Vite & Git treat pkg predictably (git ignores wasm-pkg in root .gitignore)
const pkgGitignore = path.join(outDir, '.gitignore');
if (existsSync(pkgGitignore)) rmSync(pkgGitignore);
