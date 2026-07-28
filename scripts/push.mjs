// Publish flow: bump patch version, rebuild sidecar, commit + push source,
// build the installer, and publish it to GitHub Releases. Installed copies
// pick the update up automatically (checked on launch and every 3 hours).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const run = (cmd, env = {}) =>
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
pkg.version = `${maj}.${min}.${pat + 1}`;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n>> version ${pkg.version}`);

run('dotnet publish sidecar -c Release -o sidecar/dist --nologo');

run('git add -A');
try { run(`git commit -m "v${pkg.version}"`); } catch { /* nothing to commit */ }
run('git push origin main');

const token = execSync('gh auth token').toString().trim();
const publish = () => run('npx electron-builder --win --publish always', { GH_TOKEN: token });
try {
  publish();
} catch {
  console.log('\n>> publish failed (transient upload error?) — retrying once…');
  publish();
}

console.log(`\n>> v${pkg.version} published — installed copies will auto-update.`);
