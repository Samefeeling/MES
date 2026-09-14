import { existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const major = Number(process.versions.node.split('.')[0]);
const supported = major === 18 || major === 20 || major >= 22;
const problems = [];

if (!supported) {
  problems.push(
    `Node ${process.version} is unsupported. Use Node 22 (run "nvm install 22 && nvm use 22") or rebuild the Codespace container.`,
  );
}

if (typeof webcrypto?.getRandomValues !== 'function') {
  problems.push(
    'Web Crypto is unavailable in this Node runtime; Vite 6 cannot start. Rebuild the Codespace with the repository dev container.',
  );
}

if (!existsSync(new URL('../node_modules/.bin/vite', import.meta.url))) {
  problems.push('Vite is not installed. Run "npm ci" before "npm run dev".');
}

if (problems.length > 0) {
  console.error('\nCodespaces environment check failed:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`Environment OK: Node ${process.version}, Web Crypto and Vite are available.`);
