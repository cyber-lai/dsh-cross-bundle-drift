// Cross half: the fact, not the page.
//
// It registers one row on the profile panel's feature slot board and serves the
// data that row asks for. Answering the question costs one tree listing per
// bundle — no tarball, no reinstall — so it stays useful on a slow link.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from './lib/drift.mjs';

export const name = 'dsh-cross-bundle-drift';
export const inject = ['webServer', 'profileSlots'];

const API = '/workbench/api/cross/bundle-drift';
const CACHE_MS = 90_000;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

// The plugin lives inside the profile it inspects: .../profiles/<name>/node_modules/<this>.
function locate() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    dir = path.dirname(dir);
    if (path.basename(path.dirname(dir)) === 'profiles') {
      return { home: path.dirname(path.dirname(dir)), profile: path.basename(dir) };
    }
  }
  return { home: process.env.DSH_HOME || null, profile: process.env.DSH_PROFILE || null };
}

function renderLines(report) {
  const lines = [];
  const s = report.summary;
  lines.push(`profile ${report.profile.name} · ${s.checked} checked · ${s.clean} clean · ${s.drifted} drifted · ${s.failed} failed`);
  lines.push('');
  for (const row of report.bundles) {
    if (row.skipped) continue;
    if (row.error) {
      lines.push(`ERR   ${row.name} — ${row.error}`);
      continue;
    }
    const c = row.counts;
    const flag = row.clean ? 'ok   ' : 'DRIFT';
    lines.push(
      `${flag} ${row.name} @ ${row.ref.slice(0, 10)} (${row.refSource})  same ${c.consistent} · diff ${c.modified} · missing ${c.missingLocal} · local-only ${c.localOnly}`,
    );
    for (const item of row.modified) lines.push(`      ~ ${item.path}`);
    for (const item of row.missingLocal) lines.push(`      - ${item}`);
  }
  lines.push('');
  lines.push('local-only files are usually build output the repo ignores on purpose; only diff/missing count as drift.');
  return lines;
}

export function apply(ctx) {
  let cache = null;
  let cacheAt = 0;

  const board = typeof ctx.get === 'function' ? ctx.get('profileSlots') : null;
  if (board && typeof board.register === 'function') {
    ctx.effect(
      () =>
        board.register({
          id: 'bundle-drift',
          label: 'Bundle drift',
          order: 30,
          note: 'installed files vs the commit they came from — hashes only, no download',
          endpoint: API,
        }),
      'bundle-drift: feature row',
    );
  } else {
    ctx.logger?.warn?.('bundle-drift: no profileSlots board, serving the endpoint only');
  }

  const report = async ({ refresh, only }) => {
    if (!refresh && !only && cache && Date.now() - cacheAt < CACHE_MS) return cache;
    const { home, profile } = locate();
    if (!home) throw new Error('cannot locate DSH home; set DSH_HOME');
    const next = await buildReport({ home, profileName: profile, only: only || null });
    if (!only) {
      cache = next;
      cacheAt = Date.now();
    }
    return next;
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: API,
        handler: async (req, res) => {
          const rejection = ctx.connection?.requestRejection?.(req);
          if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
          }
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('allow', 'GET');
            res.end();
            return;
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          try {
            const body = await report({
              refresh: url.searchParams.get('refresh') === '1',
              only: url.searchParams.get('only') || null,
            });
            sendJson(res, 200, { view: { lines: renderLines(body) }, report: body });
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err), view: { lines: [] } });
          }
        },
      }),
    `bundle-drift: GET ${API}`,
  );
}
