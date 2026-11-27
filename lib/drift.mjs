// Drift between what is installed and what the remote commit actually contains.
//
// The point is to answer "is my node_modules really that commit?" without
// downloading anything: GitHub already publishes a blob sha per file, and a
// local file has a git blob sha too. Compare hashes, never bytes over the wire.
//
// Two boundaries matter, and both are facts rather than guesses:
//   - the ref is the commit pnpm resolved at install time (from the lock), so a
//     report never invents drift that is really "upstream moved on";
//   - the scope is the package's own `files` whitelist, because a source repo
//     legitimately carries sources and tests that an install never copies.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RUNTIME_DIRS = new Set(['node_modules', '.git', '.bin', '.pnpm']);
const MAX_LISTED = 40;

function sha1Blob(buffer) {
  const header = `blob ${buffer.length}\0`;
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

async function walk(dir, base = '', out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (RUNTIME_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(rel);
    }
  }
  return out;
}

// A checkout on Windows may hold CRLF where the repo stores LF. Git itself
// treats that as the same blob after normalization, and so must we: compare the
// raw hash and the LF-normalized one, and keep track of which one matched.
function hashVariants(buffer) {
  const raw = sha1Blob(buffer);
  const variants = [raw];
  let crlf = false;
  if (!buffer.includes(0)) {
    const text = buffer.toString('utf8');
    if (text.includes('\r\n')) {
      crlf = true;
      variants.push(sha1Blob(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')));
    }
  }
  return { variants, crlf };
}

async function localHashes(pkgDir) {
  const files = await walk(pkgDir);
  const map = new Map();
  for (const rel of files) {
    try {
      map.set(rel, hashVariants(await fs.readFile(path.join(pkgDir, rel))));
    } catch {
      map.set(rel, { variants: ['unreadable'], crlf: false });
    }
  }
  return map;
}

async function ghJson(args, timeout = 45000) {
  const { stdout } = await execFileAsync('gh', args, {
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return JSON.parse(stdout);
}

async function remoteTree(owner, repo, ref) {
  const tree = await ghJson(['api', `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`]);
  const blobs = new Map();
  for (const item of tree.tree || []) {
    if (item.type === 'blob') blobs.set(item.path, item.sha);
  }
  return { blobs, truncated: Boolean(tree.truncated) };
}

const defaultBranchCache = new Map();
async function defaultBranch(owner, repo) {
  const key = `${owner}/${repo}`;
  if (defaultBranchCache.has(key)) return defaultBranchCache.get(key);
  const info = await ghJson(['api', `repos/${owner}/${repo}`]);
  const branch = info.default_branch || 'main';
  defaultBranchCache.set(key, branch);
  return branch;
}

// pnpm records the resolved commit in the lock; that is the ref the install
// actually used, and the only one worth comparing against. Two spellings occur:
// a codeload tarball URL, or a git+https URL with the commit in the fragment.
function commitsByRepo(lockText) {
  const out = new Map();
  const patterns = [
    /(?:codeload\.github\.com|github\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:tar\.gz|zip|tarball)\/([0-9a-f]{40})/g,
    /git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git#([0-9a-f]{40})/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(lockText)) !== null) out.set(`${m[1]}/${m[2]}`, m[3]);
  }
  return out;
}

function parseGithubSpec(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('github:')) return null;
  const body = spec.slice('github:'.length);
  const hashAt = body.indexOf('#');
  const target = hashAt === -1 ? body : body.slice(0, hashAt);
  const ref = hashAt === -1 ? null : body.slice(hashAt + 1);
  const parts = target.split('/');
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1], ref };
}

// A `files` entry is a glob against the package root. Enough glob to cover real
// manifests: *, **, ?, and literal segments.
function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '^';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.[]{}()|+'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$');
}

// null means "the whole repo is in scope": no whitelist declared.
function scopeOf(pkgJson) {
  const files = Array.isArray(pkgJson?.files) ? pkgJson.files.filter((f) => typeof f === 'string') : [];
  if (files.length === 0) return null;
  const include = files.filter((f) => !f.startsWith('!')).map(globToRegExp);
  const exclude = files.filter((f) => f.startsWith('!')).map((f) => globToRegExp(f.slice(1)));
  const inScope = (rel) => {
    if (exclude.some((re) => re.test(rel))) return false;
    if (include.length === 0) return true;
    // A directory entry like "lib" scopes everything beneath it.
    return include.some((re) => re.test(rel)) || include.some((re) => re.test(rel.split('/')[0]));
  };
  return { inScope, patterns: files };
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function resolveProfileDir(home, preferred = null) {
  if (!home) throw new Error('home unknown: set DSH_HOME');
  const profilesDir = path.join(home, 'profiles');
  if (preferred) {
    const dir = path.join(profilesDir, preferred);
    await fs.access(path.join(dir, 'package.json'));
    return { name: preferred, dir };
  }
  const names = [];
  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    try {
      await fs.access(path.join(profilesDir, arg, 'package.json'));
      names.push(arg);
    } catch {
      /* not a profile */
    }
  }
  if (names.length) return { name: names[names.length - 1], dir: path.join(profilesDir, names[names.length - 1]) };
  const entries = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(profilesDir, entry.name, 'package.json'));
      return { name: entry.name, dir: path.join(profilesDir, entry.name) };
    } catch {
      /* next */
    }
  }
  throw new Error('no profile with package.json under ' + profilesDir);
}

async function compareOne({ name, spec, pkgDir, owner, repo, ref, refSource }) {
  const local = await localHashes(pkgDir);
  const remote = await remoteTree(owner, repo, ref);
  let scope = null;
  try {
    scope = scopeOf(await readJson(path.join(pkgDir, 'package.json')));
  } catch {
    scope = null;
  }

  const modified = [];
  const missingLocal = [];
  let consistent = 0;
  let lineEndingOnly = 0;
  let outOfScope = 0;

  for (const [rel, sha] of remote.blobs) {
    if (scope && !scope.inScope(rel)) {
      outOfScope += 1;
      continue;
    }
    const mine = local.get(rel);
    if (mine === undefined) missingLocal.push(rel);
    else if (mine.variants.includes(sha)) {
      consistent += 1;
      if (mine.variants[0] !== sha) lineEndingOnly += 1;
    } else modified.push({ path: rel, remote: sha.slice(0, 10), local: String(mine.variants[0]).slice(0, 10) });
  }

  const localOnly = [];
  for (const rel of local.keys()) if (!remote.blobs.has(rel)) localOnly.push(rel);

  return {
    name,
    spec,
    source: `${owner}/${repo}`,
    ref,
    refSource,
    scope: scope ? scope.patterns : 'whole repo',
    counts: {
      consistent,
      modified: modified.length,
      missingLocal: missingLocal.length,
      localOnly: localOnly.length,
      outOfScope,
      lineEndingOnly,
      remote: remote.blobs.size,
      local: local.size,
    },
    clean: modified.length === 0 && missingLocal.length === 0,
    modified: modified.slice(0, MAX_LISTED),
    missingLocal: missingLocal.slice(0, MAX_LISTED),
    localOnlySample: localOnly.slice(0, MAX_LISTED),
    note: localOnly.length
      ? 'local files absent upstream are usually build output (lib/, dist/) that the repo ignores on purpose'
      : null,
  };
}

export async function buildReport({ home, profileName = null, only = null, includeNpm = false } = {}) {
  const profile = await resolveProfileDir(home, profileName);
  const manifest = await readJson(path.join(profile.dir, 'package.json'));
  const deps = manifest.dependencies || {};
  const lockText = await fs.readFile(path.join(profile.dir, 'pnpm-lock.yaml'), 'utf8').catch(() => '');
  const commits = commitsByRepo(lockText);

  const targets = [];
  for (const [name, spec] of Object.entries(deps)) {
    const gh = parseGithubSpec(spec);
    if (!gh) {
      if (includeNpm) targets.push({ name, spec, kind: 'npm' });
      continue;
    }
    if (only && only !== name) continue;
    targets.push({ name, spec, kind: 'github', owner: gh.owner, repo: gh.repo, pin: gh.ref });
  }

  const results = [];
  for (const target of targets) {
    if (target.kind === 'npm') {
      results.push({ name: target.name, spec: target.spec, skipped: 'not a github dependency' });
      continue;
    }
    const pkgDir = path.join(profile.dir, 'node_modules', target.name);
    try {
      await fs.access(pkgDir);
    } catch {
      results.push({ name: target.name, spec: target.spec, source: `${target.owner}/${target.repo}`, error: 'not installed' });
      continue;
    }
    try {
      const locked = commits.get(`${target.owner}/${target.repo}`) || null;
      let ref = locked || target.pin || null;
      const refSource = locked ? 'lock' : target.pin ? 'spec' : 'default-branch';
      if (!ref) ref = await defaultBranch(target.owner, target.repo);
      results.push(
        await compareOne({
          name: target.name,
          spec: target.spec,
          pkgDir,
          owner: target.owner,
          repo: target.repo,
          ref,
          refSource,
        }),
      );
    } catch (err) {
      results.push({
        name: target.name,
        spec: target.spec,
        source: `${target.owner}/${target.repo}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const checked = results.filter((row) => !row.skipped && !row.error);
  return {
    schema: 'workbench/bundle-drift/1',
    generatedAt: new Date().toISOString(),
    home,
    profile: { name: profile.name, dir: profile.dir },
    method: 'git blob sha (GitHub tree) vs git blob sha of installed files; no download',
    summary: {
      checked: checked.length,
      clean: checked.filter((row) => row.clean).length,
      drifted: checked.filter((row) => !row.clean).length,
      failed: results.filter((row) => row.error).length,
      skipped: results.filter((row) => row.skipped).length,
    },
    bundles: results,
  };
}
