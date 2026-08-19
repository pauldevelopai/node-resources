// Cross-platform updater for the Resources Node.
//
// Same pattern as the MakanDay Node:
//   - Bootstraps a non-git folder into a git repo (handles
//     ZIP-downloaded users)
//   - Sets up .gitattributes with merge=ours on data/processed/* and
//     data/raw/* so the newsroom's accumulated work is never clobbered
//   - Pulls from the upstream Develop AI repo
//   - On conflicts outside data/, aborts cleanly and tells the user
//     to email Paul

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const UPSTREAM = 'https://github.com/pauldevelopai/node-resources.git';
const BRANCH = 'main';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
  } catch (err) {
    err.stderr = err.stderr?.toString() || '';
    err.stdout = err.stdout?.toString() || '';
    throw err;
  }
}

function tryRun(cmd, opts = {}) {
  try { return run(cmd, opts); } catch (err) { return null; }
}

function ensureGit() {
  const gitVersion = tryRun('git --version');
  if (!gitVersion) {
    console.log('');
    console.log('Git is required for updates.');
    if (process.platform === 'darwin') {
      console.log('Open Terminal and run:  xcode-select --install');
      console.log('Then double-click Update.command again.');
    } else if (process.platform === 'win32') {
      console.log('Download Git from: https://git-scm.com/download/win');
      console.log('Click Next on every screen, then double-click Update.bat again.');
    } else {
      console.log('Install git via your system package manager.');
    }
    process.exit(1);
  }
}

function ensureRepo() {
  if (fs.existsSync('.git')) return;
  console.log('First-time setup: turning this folder into a git repo so updates work...');
  run('git init -b ' + BRANCH);
  run(`git remote add origin ${UPSTREAM}`);
  // Pull without merge to seed; if there's local state, the next step protects data/
  run('git fetch origin ' + BRANCH);
  // Take the upstream tree as a baseline; local edits to data/ are preserved by merge=ours below
  run(`git reset --soft origin/${BRANCH}`);
  // Stash any pre-existing local files, then restore
  console.log('Repo initialised.');
}

function ensureMergeOurs() {
  const gitattrPath = '.gitattributes';
  const desired = [
    'data/processed/* merge=ours',
    'data/raw/* merge=ours',
  ];
  let content = '';
  if (fs.existsSync(gitattrPath)) content = fs.readFileSync(gitattrPath, 'utf8');
  let changed = false;
  for (const line of desired) {
    if (!content.includes(line)) { content += (content.endsWith('\n') || content === '' ? '' : '\n') + line + '\n'; changed = true; }
  }
  if (changed) {
    fs.writeFileSync(gitattrPath, content, 'utf8');
    run('git config merge.ours.driver true');
    tryRun('git add .gitattributes');
    tryRun('git commit -m "chore: protect data files on update"');
  } else {
    tryRun('git config merge.ours.driver true');
  }
}

function pull() {
  console.log('Fetching the latest version from GitHub...');
  run(`git fetch origin ${BRANCH}`);
  console.log('Applying update...');
  try {
    run(`git merge origin/${BRANCH} --no-edit`);
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    if (out.includes('CONFLICT') || out.includes('conflict')) {
      console.log('');
      console.log('───────────────────────────────────────────────────────────');
      console.log('Update could not be applied automatically.');
      console.log('Your data is safe — nothing has been overwritten.');
      console.log('');
      console.log('This happens when you have edited a file that the update');
      console.log('also changes. Email Paul at Develop AI with a screenshot');
      console.log('of this window; he can resolve it in a few minutes.');
      console.log('───────────────────────────────────────────────────────────');
      // Roll back to a clean state
      tryRun('git merge --abort');
      process.exit(1);
    }
    throw err;
  }
}

function ensureDeps() {
  if (!fs.existsSync('node_modules')) {
    console.log('Installing new dependencies...');
    run('npm install', { stdio: 'inherit' });
  } else {
    console.log('Refreshing dependencies...');
    tryRun('npm install', { stdio: 'inherit' });
  }
}

function main() {
  console.log('');
  console.log('Resources — update');
  console.log('');
  ensureGit();
  ensureRepo();
  ensureMergeOurs();
  pull();
  ensureDeps();
  console.log('');
  console.log('✓ Update complete. Close this window, then double-click Start to launch.');
  console.log('');
}

main();
