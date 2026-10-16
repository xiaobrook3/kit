#!/usr/bin/env node
// Brings the working kit in this folder up to date and unlocks it.
//
//   node get.mjs              pull the latest, ask for the passphrase, unpack, set up the code
//   KIT_PASS=... node get.mjs the same without the question (for an agent)
//
// Needs Node 18 or later, git and tar. Nothing is sent anywhere: it pulls this public
// repository, decrypts kit.enc here, and unpacks it into this folder.
import { execFileSync } from 'node:child_process';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: KIT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

if (existsSync(join(KIT, '.git'))) {
  try {
    run('git', ['pull', '--ff-only', '-q']);
  } catch {
    console.log('Could not pull the latest (offline?). Using the copy already here.');
  }
}

function ask(prompt) {
  if (!process.stdin.isTTY) {
    console.error('No terminal to ask in. Run it as: KIT_PASS=<passphrase> node get.mjs');
    process.exit(1);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let shown = false;
    rl._writeToOutput = (s) => {
      if (!shown) process.stdout.write(s);
      shown = true;
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Forgiving about case and separators: "Olive Tundra ..." and "olive-tundra-..." are the same.
const normalize = (p) => p.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');

const pass = normalize(process.env.KIT_PASS ?? (await ask('Passphrase: ')));
const box = readFileSync(join(KIT, 'kit.enc'));
if (box.subarray(0, 4).toString() !== 'KIT1') {
  console.error('kit.enc is not a kit file.');
  process.exit(1);
}
const logN = box[4];
const salt = box.subarray(5, 21);
const iv = box.subarray(21, 33);
const tag = box.subarray(33, 49);
const key = scryptSync(pass, salt, 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 1024 * 1024 * 1024 });
let tgz;
try {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  tgz = Buffer.concat([d.update(box.subarray(49)), d.final()]);
} catch {
  console.error('That passphrase does not open the kit. Check it with Brook.');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'kit-'));
writeFileSync(join(tmp, 'kit.tgz'), tgz);
run('tar', ['-xzf', join(tmp, 'kit.tgz'), '-C', KIT]);
rmSync(tmp, { recursive: true, force: true });

const version = existsSync(join(KIT, 'VERSION')) ? readFileSync(join(KIT, 'VERSION'), 'utf8').trim() : '';
console.log(`Unlocked. ${version}`);

// Notes from Claude on Brook's Mac: show the ones not seen on this machine before.
const inbox = join(KIT, 'inbox');
const seenFile = join(KIT, '.seen');
const seen = new Set(existsSync(seenFile) ? readFileSync(seenFile, 'utf8').split('\n') : []);
const notes = existsSync(inbox) ? readdirSync(inbox).filter((f) => f.endsWith('.md')).sort() : [];
const fresh = notes.filter((f) => !seen.has(f));
if (fresh.length) {
  console.log(`\nNew in inbox/ (${fresh.length}):`);
  for (const f of fresh) {
    const first = readFileSync(join(inbox, f), 'utf8').split('\n').find((l) => l.trim()) ?? '';
    console.log(`  ${f}  ${first.replace(/^#+\s*/, '')}`);
  }
} else {
  console.log('\nNo new notes in inbox/.');
}
writeFileSync(seenFile, notes.join('\n'));

// The prepared code, from the bundle in the kit (no GitHub account needed).
const bundle = join(KIT, 'rapid-starter.bundle');
const code = join(KIT, 'rapid-starter');
if (existsSync(bundle) && !process.argv.includes('--no-code')) {
  try {
    if (!existsSync(join(code, '.git'))) {
      run('git', ['clone', '-q', '-b', 'next', bundle, code]);
      console.log(`\nPrepared code: ${code} (${run('git', ['-C', code, 'log', '--oneline', '-1'])})`);
    } else {
      run('git', ['-C', code, 'fetch', '-q', bundle, 'next']);
      run('git', ['-C', code, 'merge', '-q', '--ff-only', 'FETCH_HEAD']);
      console.log(`\nPrepared code updated: ${run('git', ['-C', code, 'log', '--oneline', '-1'])}`);
    }
  } catch {
    console.log('\nPrepared code has local changes, so it was left as it is.');
  }
}

console.log(`
Read first: ${join(KIT, 'HANDOFF.md')} (section 0), then the notes in ${inbox}
Start Claude Code with the skills:
  claude --plugin-dir ${join(KIT, 'plugin')} --plugin-dir ${code} --add-dir ${KIT}
Or tell a session already running: "Read ${join(KIT, 'CLAUDE.md')} and follow it."
Run this again for updates.`);
