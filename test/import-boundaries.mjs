// The drop-in guarantee (plan step 1.1): src/chat/ imports nothing from the
// rest of this service, and nothing there imports it back.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAT = join(root, 'src', 'chat');
const BACK = join(root, 'src', 'runner'), LLM = join(root, 'src', 'llm'), DB = join(root, 'src', 'db.js');

function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let bad = 0;
for (const f of walk(CHAT)) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = new URL(m[1], 'file://' + f).pathname;
    if (target === DB || target.startsWith(BACK) || target.startsWith(LLM)) {
      console.error(`FAIL - ${relative(root, f)} imports ${relative(root, target)}`);
      bad++;
    }
  }
}
for (const dir of [BACK, LLM]) {
  for (const f of walk(dir)) {
    const text = readFileSync(f, 'utf8');
    if (/from\s+['"]\.\.\/chat/.test(text)) {
      console.error(`FAIL - ${relative(root, f)} imports the chat back`);
      bad++;
    }
  }
}

console.log(bad ? `${bad} boundary violations` : 'ok - chat keeps to itself');
process.exit(bad ? 1 : 0);
