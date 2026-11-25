// The one git entry point the IPC handler calls: explicit op allowlist, per-op argument
// validation, and errors encoded for the IPC boundary (Electron forwards only `message`).
import { branchName, createEngine } from './engine.mjs';
import { commitAuthor } from './auth.mjs';
import { parseRemote } from './github.mjs';
import { lfs, partition } from './into.mjs';
import { deploysPages, ownPagesWorkflow, PAGES_WORKFLOW, pagesFilesCurrent, writePagesFiles } from './pages.mjs';
import { freeName, pageHash, siteSlug } from '../cloudflare.mjs';
import { t } from '../i18n.mjs';

const fail = (code, message, extra) => Object.assign(new Error(t(message)), { code }, extra);
const str = (v, name, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw fail('invalid', `Invalid ${name}`);
  return v.trim();
};
const oid = v => { if (typeof v !== 'string' || !/^[0-9a-f]{40}$/.test(v)) throw fail('invalid', 'Invalid version id'); return v; };
const OFFLINE = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'];
// Publish hosts (docs/plans/2026-10-14-github-publish-design.md); the choice lives in the repo's .git/config.
const HOSTS = ['pages', 'netlify', 'vercel', 'github', 'cloudflare'];
const HOST = 'starquix.host';
// Cloudflare (docs/plans/2026-10-16-cloudflare-one-click-design.md C5): the project's Worker beside the host choice.
const CF = { account: 'starquix.cloudflareAccount', worker: 'starquix.cloudflareWorker', tag: 'starquix.cloudflareTag',
  published: 'starquix.cloudflarePublished', domain: 'starquix.cloudflareDomain', attached: 'starquix.cloudflareAttached',
  probe: 'starquix.cloudflareProbe', // "<sha256> <path>" of a page the last publish uploaded: what "Live" checks (ledger 20/61)
  offline: 'starquix.cloudflareOffline' }; // unpublished: the Worker is gone, its name + domain kept for "Publish again" (U2–U4)
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const REGISTERING = ['pending', 'in_progress', 'blocked']; // ledger 54: Cloudflare is still working (blocked = a third party)
const CACHE_MS = 5 * 60_000; // the default branch and the Pages URL rarely change: a 10 s poll must not re-ask

/** Normalizes any thrown error to `{ code, message, ...extra }` and encodes it as `sq-git:<json>`. */
export function encodeError(e) {
  let code = e?.code ?? 'error';
  const cause = e?.cause?.code ?? e?.data?.code;
  if (OFFLINE.includes(code) || OFFLINE.includes(cause) || e?.name === 'TypeError' && /fetch failed/.test(e.message) || e?.name === 'TimeoutError') code = 'offline';
  else if (code === 'HttpError' && [401, 403].includes(e.data?.statusCode) || code === 'UserCanceledError') code = 'signed-out';
  else if (code === 'HttpError' && e.data?.statusCode === 404) code = 'repo-gone';
  const payload = { code, message: code === 'offline' ? 'You are offline' : e?.message ?? String(e) };
  for (const k of ['suggestion', 'settingsUrl', 'snippet', 'branch', 'status', 'price', 'currency', 'file']) if (e?.[k]) payload[k] = e[k];
  return new Error(`sq-git:${JSON.stringify(payload)}`);
}

/** Process-wide sign-in state (one GitHub account per app, not per project). */
export function createGitContext({ auth, github, http, pages, cloudflare, build, typeCheck }) {
  const ctx = { auth, github, http, pages, cloudflare, build, typeCheck, user: null, signIn: null, cache: new Map(), reached: new Set() };
  ctx.onAuth = async () => {
    const t = await auth.token();
    return t ? { username: t, password: 'x-oauth-basic' } : { cancel: true };
  };
  return ctx;
}

/** Remembers a GitHub answer for CACHE_MS (never a null one: "not there yet" must be re-asked). */
/** The Worker a Cloudflare publish uploads to. 18: ours = gone (recreate), untagged (killed mid-publish: adopt) or carrying
 *  our tag; else a free name (16/17: never a name in the account), stored before anything is uploaded (16/32). */
async function cloudflareWorker(cf, engine, account, name) {
  const [scripts, mine, tag] = await Promise.all([cf.scripts(account.id), ownWorker(engine, account), engine.config(CF.tag)]);
  const there = mine && scripts.find(s => s.name === mine);
  let worker = mine && (!there || !tag || there.tag === tag) ? mine : null;
  const confirmed = !!(there && tag && there.tag === tag);
  if (!worker) {
    worker = freeName(new Set(scripts.map(s => s.name)), siteSlug(name));
    for (const k of [CF.tag, CF.published, CF.domain, CF.attached, CF.probe]) await engine.setConfig(k, undefined);
    await engine.setConfig(CF.account, account.id); await engine.setConfig(CF.worker, worker);
  } else if (!confirmed) await engine.setConfig(CF.tag, undefined); // recreated / adopted: untagged until it is complete
  return { worker, there, tag, confirmed };
}

async function cached(ctx, key, load) {
  const hit = ctx.cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  if (value != null) ctx.cache.set(key, { value, at: Date.now() });
  return value;
}
/** The repo's default branch on GitHub: Netlify/Vercel build it as production; Pages shows it unless Publish picked another. */
const liveBranch = (ctx, gh) => cached(ctx, `branch:${gh.owner}/${gh.repo}`, () => ctx.github.defaultBranch(gh.owner, gh.repo));
// Pages' site branch as Publish picked it (docs/plans/2026-10-20-publish-branch-selection-design.md B1): '' = unset (the
// default branch), so the answer caches. A switch writes the cache itself (ledger 9).
const pickedKey = gh => `site:${gh.owner}/${gh.repo}`;
const pickedBranch = (ctx, gh) => cached(ctx, pickedKey(gh), async () => (await ctx.github.pagesBranch(gh.owner, gh.repo)) ?? '');
const ruleKey = gh => `rule:${gh.owner}/${gh.repo}`;
/** After a switch: its branch, and GitHub's rule asked again (the switch may have changed it). */
const picked = (ctx, gh, branch, live) => { ctx.cache.set(pickedKey(gh), { value: branch === live ? '' : branch, at: Date.now() }); ctx.cache.delete(ruleKey(gh)); };
/** Ledger 48: does github-pages let `branch` deploy? A wildcard entry counts as yes (no false alarm: a real refusal still
 *  shows as Build failed); protected-only lets the default branch (it deployed before); no rule / no environment = yes. */
const deploys = (rule, branch, live) => (rule.mode === 'list' ? rule.list.some(p => p.name === branch || /[*?[{]/.test(p.name))
  : rule.mode !== 'protected' || branch === live);
async function requireRemote(engine) {
  const remote = await engine.remote();
  if (!remote) throw fail('invalid', 'Publish to GitHub first');
  return { remote, gh: parseRemote(remote) };
}
/** Save the user's pending edits as their own version (Publish saves for them; nothing pending is fine). */
const saveEdits = (engine, message, author) => engine.save(message, author).catch(e => { if (e.code !== 'nothing') throw e; });

// Publish into an existing repo (docs/plans/2026-10-18-publish-into-existing-repo-design.md): ledger numbers below.
const ghName = (v, what) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(v) || v === '.' || v === '..') throw fail('invalid', `Invalid ${what}`);
  return v;
};
const LARGE_KB = 50_000; // 20: "it can take a minute" (GitHub reports the repo size in KB)
/** 9/17–19: what Publish into refuses, in the words the editor shows. */
const unsupported = (repo, why) => fail('repo-unsupported', `${repo} ${t(why)}`);
const SUBMODULES = "uses Git submodules. Starquix can't publish into it yet.";
const LFS = "stores files with Git LFS. Starquix can't publish into it yet.";
function refuseRepo(info) {
  if (info.archived) throw unsupported(info.repo, 'is archived on GitHub (read-only).');
  if (!info.push) throw fail('no-access', `You can't push to ${info.owner}/${info.repo}.`);
}
const isAstro = pkg => { try { const p = JSON.parse(pkg); return !!(p?.dependencies?.astro ?? p?.devDependencies?.astro); } catch { return false; } };
/** GitHub's kept files as the preview names them: top-level names, folders with a trailing slash. */
const topLevel = keep => [...new Set(keep.map(e => (e.path.includes('/') ? `${e.path.split('/')[0]}/` : e.path)))].sort();

/** The signed-in Cloudflare account, or why there is none (ledger 8/11). */
async function signedInAccount(cf) {
  const account = await cf.account();
  if (account) return account;
  throw await cf.connected() ? fail('choose-account', 'Choose a Cloudflare account') : fail('cloudflare-signed-out', 'Connect Cloudflare');
}
/** The project's Worker on `account`, or null — another account's Worker is not this account's (ledger 15). */
const ownWorker = async (engine, account) => (await engine.config(CF.account) === account.id ? await engine.config(CF.worker) : null);
/** Ledger 20/61: Live = `origin` serves the page the last publish uploaded, byte for byte. Once true per origin + page it
 *  stays true for the app's life (a new publish = a new page hash = checked again); "not yet" is asked again. */
async function reach(ctx, origin, probe) {
  const at = probe?.indexOf(' ') ?? -1;
  if (at < 0) return false; // nothing published to check against
  const [hash, path] = [probe.slice(0, at), probe.slice(at + 1)];
  const key = `${origin}${path}#${hash}`;
  if (ctx.reached.has(key)) return true;
  const ok = await ctx.cloudflare.reachable(`${origin}${encodeURI(path)}`, hash);
  if (ok) ctx.reached.add(key);
  return ok;
}
/** Ledger 53–62: the project's domain, finishing its setup while it has never been live (the only write a poll does, 72). */
async function domainState(ctx, engine, account, worker, probe) {
  const name = await engine.config(CF.domain);
  if (!name) return null;
  const out = (state, sentTo = null) => ({ name, state, sentTo });
  const cf = ctx.cloudflare; const wasLive = await engine.config(CF.attached) === 'true';
  if (await cf.attached(account, worker, name)) {
    if (!wasLive) await engine.setConfig(CF.attached, 'true');
    return out(await reach(ctx, `https://${name}`, probe) ? 'live' : 'https');
  }
  if (wasLive) return out('detached'); // 62: moved on Cloudflare on purpose? never re-attached by itself
  const reg = await cf.registration(account, name);
  if (REGISTERING.includes(reg?.state)) return out('registering');
  if (reg?.state === 'action_required') return out('confirm-email', reg.sentTo);
  if (reg?.state === 'failed') return out('failed');
  try { if (await cf.attach(account, worker, name) === 'pending') return out('setting-up'); } // 58
  catch (e) { if (e.code === 'domain-conflict') return out('conflict'); throw e; }
  await engine.setConfig(CF.attached, 'true');
  return out('https');
}

async function currentUser(ctx) {
  if (ctx.user) return ctx.user;
  try { ctx.user = await ctx.auth.user(); } catch (e) { if (e.code !== 'signed-out' && e.code !== 'unavailable') throw e; ctx.user = null; }
  return ctx.user;
}

const OPS = {
  async status(ctx, engine) {
    const s = await engine.status(); // first: it initializes the repo the others read
    const [remote, counts, user, host, pagesWorkflow] = await Promise.all([engine.remote(), engine.counts(),
      currentUser(ctx).catch(() => null), engine.config(HOST), ownPagesWorkflow(engine.dir)]);
    // Missing/old Pages files are an unpublished change: Publish changes repairs them. The repo's own Pages workflow
    // (pagesWorkflow, ledger 37) needs none of ours.
    const pagesStale = host === 'pages' && !pagesWorkflow && !(await pagesFilesCurrent(engine.dir));
    return { ...s, remote, github: parseRemote(remote), ...counts, user, host, pagesStale, pagesWorkflow };
  },
  history: (_ctx, engine) => engine.history(),
  branches: (_ctx, engine) => engine.branches(),
  save: async (ctx, engine, a) => engine.save(str(a.message, 'message'), commitAuthor(await currentUser(ctx))),
  restore: async (ctx, engine, a) => engine.restore(oid(a.oid), commitAuthor(await currentUser(ctx))),
  createBranch: (_ctx, engine, a) => engine.createBranch(str(a.name, 'branch name', 100)),
  switchBranch: (_ctx, engine, a) => engine.switchBranch(str(a.name, 'branch name', 100)),
  discard: (_ctx, engine) => engine.discard(),
  refresh: async (_ctx, engine) => { if (await engine.remote()) await engine.fetchRemote(); return engine.counts(); },
  pull: async (ctx, engine) => engine.pull(commitAuthor(await currentUser(ctx))),
  resolve(_ctx, engine, a) {
    if (!['mine', 'theirs'].includes(a.side)) throw fail('invalid', 'Invalid side');
    return engine.resolve(str(a.path, 'path', 1000), a.side);
  },
  finish: async (ctx, engine) => engine.finish(commitAuthor(await currentUser(ctx))),
  abort: (_ctx, engine) => engine.abort(),
  push: (_ctx, engine) => engine.push(),
  async publish(ctx, engine, a) {
    const name = str(a.name, 'repository name', 100);
    const user = await currentUser(ctx);
    if (a.message !== undefined) await saveEdits(engine, str(a.message, 'message'), commitAuthor(user)); // P3
    if (!(await engine.tip('HEAD'))) throw fail('nothing', 'Save a version first');
    const repo = await ctx.github.createRepo({ name, private: a.private !== false, owner: user?.login }); // owner: their EMPTY repo is adopted
    await engine.setRemote(repo.cloneUrl);
    await engine.push();
    return repo;
  },
  /** The repos the signed-in user can publish into (ledger 6–11). */
  repos: ctx => ctx.github.repos(),
  /** The preview (E4): what publishing into owner/repo would change. GitHub's REST answers + the work tree; nothing is
   *  fetched, saved or pushed. */
  async inspectRepo(ctx, engine, a) {
    const gh = ctx.github;
    const info = await gh.repo(ghName(a.owner, 'owner'), ghName(a.repo, 'repository'));
    refuseRepo(info);
    const { owner, repo, defaultBranch: branch } = info;
    const tree = await gh.tree(owner, repo, branch);
    const local = await engine.files();
    const out = { owner, repo, branch, private: info.private, large: info.size > LARGE_KB, empty: !tree, astro: true, changed: 0,
      added: local.size, removed: [], removedCount: 0, dropped: {}, kept: [], host: null, pagesWorkflow: null };
    if (!tree) return out; // 14: an empty repo just takes the project
    if (tree.truncated) throw unsupported(repo, 'has too many files to publish into.'); // 19
    const parts = partition(tree.entries, local);
    if (parts.submodules) throw unsupported(repo, SUBMODULES); // 18
    const blobs = new Set(tree.entries.filter(e => e.type === 'blob').map(e => e.path));
    if (blobs.has('.gitattributes') && lfs(await gh.text(owner, repo, '.gitattributes', branch))) throw unsupported(repo, LFS); // 17
    const workflows = [...blobs].filter(p => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) && !p.endsWith(`/${PAGES_WORKFLOW}`)).sort().slice(0, 10);
    const [pkg, ...texts] = await Promise.all([blobs.has('package.json') ? gh.text(owner, repo, 'package.json', branch) : null,
      ...workflows.map(p => gh.text(owner, repo, p, branch))]);
    const pagesWorkflow = workflows.find((_p, i) => deploysPages(texts[i]))?.split('/').pop() ?? null;
    // 36–39: its own Pages workflow > the Vercel/Netlify bot that deploys it > Pages turned on > nothing known.
    const host = pagesWorkflow ? 'pages' : (await gh.deployedBy(owner, repo)) ?? (info.hasPages ? 'pages' : null);
    return { ...out, astro: isAstro(pkg), changed: parts.changed, added: parts.added, removed: parts.removed.sort().slice(0, 20),
      removedCount: parts.removed.length, dropped: parts.dropped, kept: topLevel(parts.keep), host, pagesWorkflow };
  },
  /** E1/E2: the project's files on top of GitHub's history in owner/repo, GitHub's own files kept; the repo becomes origin.
   *  E6: `branch` = a NEW branch on GitHub (the version still sits on the default branch's tip: a pull request merges it). */
  async publishInto(ctx, engine, a) {
    const [owner, name] = [ghName(a.owner, 'owner'), ghName(a.repo, 'repository')];
    const asked = a.branch === undefined ? null : branchName(a.branch); // 55
    if (await engine.remote()) throw fail('invalid', 'Already on GitHub'); // 2
    const info = await ctx.github.repo(owner, name);
    refuseRepo(info);
    const live = info.defaultBranch;
    const branch = asked ?? live;
    if (branch !== live && await ctx.github.branchExists(info.owner, info.repo, branch)) { // 54
      throw fail('branch-exists', `${branch} already exists on ${info.repo}. Pick a new branch name, or ${live}.`);
    }
    if (await engine.branch() !== branch && (await engine.branches()).includes(branch)) { // 27: before anything is saved or fetched
      throw Object.assign(fail('branch-taken', `${branch} is another branch in this project`), { branch });
    }
    const author = commitAuthor(await currentUser(ctx));
    if (a.message !== undefined) await saveEdits(engine, str(a.message, 'message'), author); // P3
    if (!(await engine.tip('HEAD'))) throw fail('nothing', 'Save a version first');
    try {
      const tip = await engine.fetchTip(info.cloneUrl, live); // null: an empty repo (14); a new branch starts from it (53)
      let keep = [];
      if (tip) {
        const parts = partition(tip.entries, await engine.files());
        const attrs = tip.entries.find(e => e.path === '.gitattributes');
        const refusal = parts.submodules ? SUBMODULES : attrs && lfs(await engine.readText(attrs.oid)) ? LFS : null; // GitHub moved since the preview
        if (refusal) { await engine.dropTip(); throw unsupported(info.repo, refusal); }
        keep = parts.keep;
      }
      const { wrote } = await engine.publishInto({ url: info.cloneUrl, branch, tip: tip?.oid ?? null, keep, author, message: t('Publish from Starquix') });
      return { owner: info.owner, repo: info.repo, htmlUrl: info.htmlUrl, wrote };
    } catch (e) {
      if (e.code === 'HttpError' && e.data?.statusCode === 403) throw fail('no-access', t("Starquix can't push to {owner}/{repo}.", { owner: info.owner, repo: info.repo })); // 31
      throw e;
    }
  },
  disconnect: (_ctx, engine) => engine.removeRemote(),
  /** Where the site lives. Pages is turned on here (pages.enable); Netlify/Vercel connect on their side.
   *  Returns whether files were written (the editor re-mirrors only then). */
  async setHost(ctx, engine, a) {
    if (!HOSTS.includes(a.host)) throw fail('invalid', 'Invalid host');
    if (a.host === 'cloudflare') { await engine.setConfig(HOST, 'cloudflare'); return { wrote: false }; } // C7: no GitHub needed
    const { gh } = await requireRemote(engine);
    let wrote = false;
    if (a.host === 'pages') {
      if (!gh) throw fail('invalid', 'GitHub Pages needs a GitHub repository');
      // B5 (docs/plans/2026-10-20-publish-branch-selection-design.md): the branch you're on becomes the site branch. The
      // repo's own Pages workflow writes nothing here — its own triggers decide (docs/plans/2026-10-18-…, ledger 56).
      const own = !!(await ownPagesWorkflow(engine.dir));
      const [live, branch] = own ? [null, null] : [await liveBranch(ctx, gh), await engine.branch()];
      const author = commitAuthor(await currentUser(ctx));
      await saveEdits(engine, str(a.message ?? 'Update site', 'message'), author); // never inside the Pages version
      wrote = await ctx.pages.enable({ engine, ...gh, author, own, branch, live });
      if (!own) picked(ctx, gh, branch, live);
    }
    await engine.setConfig(HOST, a.host);
    return { wrote };
  },
  /** One click: save what changed, push when HEAD moved past GitHub; the host rebuilds. Pages re-ensures its files. */
  async publishChanges(ctx, engine, a) {
    const message = str(a.message, 'message');
    await requireRemote(engine);
    const wrote = await engine.config(HOST) === 'pages' && !(await ownPagesWorkflow(engine.dir)) && await writePagesFiles(engine.dir);
    await saveEdits(engine, message, commitAuthor(await currentUser(ctx)));
    if (await engine.tip('HEAD') !== await engine.tip(`refs/remotes/origin/${await engine.branch()}`)) await engine.push();
    return { wrote };
  },
  /** Before a publish that can start a host build: what the site's own `astro check` says about the folder, run on a copy
   *  (docs/plans/2026-10-20-prepublish-type-check-design.md). */
  typeCheck: (ctx, engine) => ctx.typeCheck(engine.dir),
  /** Which branch GitHub Pages shows (docs/plans/2026-10-20-publish-branch-selection-design.md, ledger 10–29): the branch
   *  you're on, or the default branch from anywhere. Checks first; GitHub's side changes before the build starts (the push
   *  run reads the new variable); then your branch is saved + pushed, or the workflow is started (nothing new to push). */
  async pagesBranch(ctx, engine, a) {
    const [branch, message] = [str(a.branch, 'branch name', 100), str(a.message, 'message')];
    const { gh } = await requireRemote(engine);
    if (!gh || await engine.config(HOST) !== 'pages' || await ownPagesWorkflow(engine.dir)) throw fail('invalid', t('GitHub Pages is not published by Starquix here'));
    if (await engine.mergeState()) throw fail('merging', 'Finish the merge first'); // 24
    const [live, here] = [await liveBranch(ctx, gh), await engine.branch()];
    if (branch !== here && branch !== live) throw fail('invalid', 'Pick the branch you are on or the default branch');
    if (branch !== here && !(await ctx.github.text(gh.owner, gh.repo, `.github/workflows/${PAGES_WORKFLOW}`, live))) { // 27
      throw fail('pages-not-set-up', `${live} has no GitHub Pages setup yet.`, { branch: live });
    }
    await ctx.pages.setSiteBranch({ ...gh, branch, live }); // 14–19: refusals change nothing
    picked(ctx, gh, branch, live);
    if (branch !== here) { await ctx.github.dispatchPages(gh.owner, gh.repo, branch); return { wrote: false }; } // 28: your edits stay
    const wrote = await writePagesFiles(engine.dir); // 13
    await saveEdits(engine, message, commitAuthor(await currentUser(ctx))); // 10
    if (await engine.tip('HEAD') !== await engine.tip(`refs/remotes/origin/${here}`)) await engine.push(); // 11
    else await ctx.github.dispatchPages(gh.owner, gh.repo, branch); // 12
    return { wrote };
  },
  async makePublic(ctx, engine) {
    const { gh } = await requireRemote(engine);
    if (!gh) throw fail('invalid', 'GitHub Pages needs a GitHub repository');
    await ctx.github.makePublic(gh.owner, gh.repo);
  },
  async signIn(ctx) {
    const s = await ctx.auth.start();
    ctx.signIn = s.done.then(() => { ctx.user = null; });
    ctx.signIn.catch(() => {});
    return { userCode: s.userCode, verificationUri: s.verificationUri };
  },
  async signInWait(ctx) {
    if (!ctx.signIn) throw fail('invalid', 'No sign-in in progress');
    try { await ctx.signIn; } finally { ctx.signIn = null; }
    return currentUser(ctx);
  },
  signInCancel: ctx => { ctx.auth.cancel(); },
  signOut: async ctx => { ctx.user = null; await ctx.auth.signOut(); },
  user: ctx => currentUser(ctx),
  /** Polled while the Publish modal waits: ref reads only (no tree walk), GitHub calls in parallel, rare answers cached. */
  async deployStatus(ctx, engine) {
    const [gh, host] = [parseRemote(await engine.remote()), await engine.config(HOST)];
    if (!gh || !host || host === 'cloudflare') return { state: 'none', url: null, liveUrl: null, liveBranch: null, defaultBranch: null, siteBlocked: false }; // Cloudflare: cloudflareStatus
    const sha = await engine.tip(`refs/remotes/origin/${await engine.branch()}`);
    const own = host === 'pages' ? await ownPagesWorkflow(engine.dir) : null;
    const workflow = host === 'pages' ? own ?? PAGES_WORKFLOW : undefined; // ledger 37
    const ours = host === 'pages' && !own;
    const [report, live, site, rule, pagesUrl] = await Promise.all([
      sha ? ctx.github.deployStatus(gh.owner, gh.repo, sha, host, workflow) : { state: 'none', url: null },
      liveBranch(ctx, gh),
      ours ? pickedBranch(ctx, gh) : '', // B1: Starquix's workflow builds the site branch
      ours ? cached(ctx, ruleKey(gh), () => ctx.github.pagesRule(gh.owner, gh.repo)) : null, // 48
      host === 'pages' ? cached(ctx, `pages:${gh.owner}/${gh.repo}`, () => ctx.github.pagesUrl(gh.owner, gh.repo)) : null,
    ]);
    const liveUrl = pagesUrl ?? (report.state === 'success' && (host === 'netlify' || host === 'vercel')
      ? await ctx.github.deploymentUrl(gh.owner, gh.repo, sha, host) : null);
    // liveBranch = the branch the site shows (Pages: the site branch); defaultBranch = GitHub's default (Back to …, PR base);
    // siteBlocked = GitHub's github-pages rule refuses that branch (48: the switch repairs it).
    const shows = site || live;
    return { ...report, liveUrl, liveBranch: shows, defaultBranch: live, siteBlocked: !!rule && !deploys(rule, shows, live) };
  },
  /** Cloudflare, one click (C1/C2/C6): save the edits as a version, build locally, upload the assets-only Worker. */
  async cloudflarePublish(ctx, engine, a) {
    const name = str(a.name, 'site name', 1000); const message = str(a.message, 'message');
    const cf = ctx.cloudflare; const account = await signedInAccount(cf);
    await saveEdits(engine, message, commitAuthor(await currentUser(ctx).catch(() => null)));
    const files = await ctx.build(engine.dir); // build-failed / not-static / file-too-big: nothing uploaded (21–24)
    const { worker, there, tag, confirmed } = await cloudflareWorker(cf, engine, account, name);
    await engine.setConfig(HOST, 'cloudflare');
    const uploaded = await cf.upload(account.id, worker, files);
    if (!confirmed) { // a new, recreated or adopted Worker gets its workers.dev address; an existing one keeps the user's setting
      if (!(await cached(ctx, `cf-sub:${account.id}`, () => cf.subdomain(account.id)))) await cf.createSubdomain(account.id, siteSlug(name)); // 19
      await cf.enableWorkersDev(account.id, worker);
    }
    // The tag marks a COMPLETE publish: a failed workers.dev step leaves it unset, so the next publish redoes it (review 2);
    // an answer without one falls back to the account list's (review 9).
    await engine.setConfig(CF.tag, uploaded ?? there?.tag ?? tag ?? undefined);
    // The page "Live" checks: the home page (served at its pretty path), else the first page (the build always has one).
    const page = files.find(f => f.path === '/index.html') ?? files.find(f => f.path.endsWith('.html'));
    await engine.setConfig(CF.probe, `${pageHash(page.bytes)} ${page.path.replace(/index\.html$/, '')}`);
    await engine.setConfig(CF.published, (await engine.tip('HEAD')) ?? '');
    await engine.setConfig(CF.offline, undefined); // U4: back online
    return { wrote: false };
  },
  /** The address the next publish serves — the project's domain, else its Worker's workers.dev address — so the editor
   *  writes it into the site's astro.config BEFORE the publish builds (owner 2026-11-17). Picks and keeps the Worker name
   *  and creates the account's workers.dev subdomain when there is none (19), as the publish itself would. */
  async cloudflareAddress(ctx, engine, a) {
    const name = str(a.name, 'site name', 1000);
    const cf = ctx.cloudflare; const account = await signedInAccount(cf);
    const domain = await ownWorker(engine, account) && await engine.config(CF.domain);
    if (domain) return { url: `https://${domain}` };
    const { worker } = await cloudflareWorker(cf, engine, account, name);
    const key = `cf-sub:${account.id}`;
    let sub = await cached(ctx, key, () => cf.subdomain(account.id));
    if (!sub) { sub = await cf.createSubdomain(account.id, siteSlug(name)); ctx.cache.set(key, { value: sub, at: Date.now() }); }
    return { url: `https://${worker}.${sub}.workers.dev` };
  },
  /** Unpublish (U2–U10): the Worker leaves Cloudflare; the project keeps its account, Worker name and domain so Publish
   *  brings the same address (and the domain, re-attached by the poll) back. Refused → nothing changes here (U5). */
  async cloudflareUnpublish(ctx, engine) {
    const cf = ctx.cloudflare; const account = await signedInAccount(cf);
    const worker = await ownWorker(engine, account);
    if (!worker || await engine.config(CF.offline) === 'true') throw fail('invalid', 'Nothing published on this account'); // U8
    await cf.unpublish(account.id, worker);
    await engine.setConfig(CF.offline, 'true');
    for (const k of [CF.tag, CF.published, CF.probe, CF.attached]) await engine.setConfig(k, undefined);
    ctx.reached.clear(); // U10: the next publish is checked again
    return { wrote: false };
  },
  /** Polled: config/ref reads + a few Cloudflare GETs, never engine.status (full tree hash). */
  async cloudflareStatus(ctx, engine) {
    const cf = ctx.cloudflare;
    const none = { connected: false, account: null, accounts: [], worker: null, published: false, domain: null, offline: null };
    if (!(await cf.connected())) return none;
    const account = await cf.account();
    if (!account) return { ...none, connected: true, accounts: await cf.accounts() }; // 11: the picker
    const [owner, name, at, head, probe, offline] = await Promise.all([engine.config(CF.account), engine.config(CF.worker), engine.config(CF.published),
      engine.tip('HEAD'), engine.config(CF.probe), engine.config(CF.offline)]);
    if (owner !== account.id || !name) return { ...none, connected: true, account }; // 15
    const sub = await cached(ctx, `cf-sub:${account.id}`, () => cf.subdomain(account.id));
    const url = sub ? `https://${name}.${sub}.workers.dev` : null;
    if (offline === 'true') return { ...none, connected: true, account, offline: url }; // U3: "Publish again" brings it back here
    // Review 6 (ledger 48): a failing domain lookup never hides the site and Publish changes; a sign-out still surfaces.
    const [domain, reachable] = await Promise.all([domainState(ctx, engine, account.id, name, probe).catch(async e => {
      if (e.code === 'cloudflare-signed-out') throw e;
      return { name: await engine.config(CF.domain), state: 'unknown', sentTo: null };
    }), !!url && reach(ctx, url, probe)]);
    return { connected: true, account, accounts: [], worker: { name, url, reachable }, published: !!head && head === at, domain, offline: null };
  },
  /** Get a domain (C3/C8): with the price the user saw → buy (main re-checks it); without one → attach a domain already
   *  theirs, never a purchase; `domain: null` forgets the shown one (Cloudflare untouched). */
  async cloudflareDomain(ctx, engine, a) {
    if (a.domain === null) { await engine.setConfig(CF.domain, undefined); await engine.setConfig(CF.attached, undefined); return { state: null }; }
    if (typeof a.domain !== 'string' || !DOMAIN.test(a.domain)) throw fail('invalid', 'Invalid domain');
    const buying = a.price !== undefined;
    if (buying && (typeof a.price !== 'string' || !/^\d{1,6}(\.\d{1,2})?$/.test(a.price) || typeof a.currency !== 'string'
      || !/^[A-Z]{3}$/.test(a.currency) || typeof a.autoRenew !== 'boolean')) throw fail('invalid', 'Invalid price');
    const cf = ctx.cloudflare; const account = await signedInAccount(cf);
    const worker = await ownWorker(engine, account);
    if (!worker) throw fail('invalid', 'Publish to Cloudflare first');
    const state = buying ? await cf.buy(account.id, a.domain, { price: a.price, currency: a.currency }, a.autoRenew) : 'succeeded';
    await engine.setConfig(CF.domain, a.domain); await engine.setConfig(CF.attached, undefined);
    // Review 3a: once bought (or taken over), a failing attach is the poll's job (58) — never a "failed purchase".
    if (state === 'succeeded' && await cf.attach(account.id, worker, a.domain).catch(() => 'pending') === 'attached') await engine.setConfig(CF.attached, 'true');
    return { state };
  },
  async cloudflareSearch(ctx, _engine, a) {
    const q = str(a.q, 'name', 253).toLowerCase().replace(/\s+/g, ' ');
    if (!/^[a-z0-9 .-]+$/.test(q)) throw fail('invalid-domain', 'Letters, numbers, dots and dashes only'); // 50: no IDN at the Registrar
    return ctx.cloudflare.search((await signedInAccount(ctx.cloudflare)).id, q);
  },
  cloudflareConnect: ctx => ctx.cloudflare.connect(),
  cloudflareAccount: (ctx, _engine, a) => ctx.cloudflare.chooseAccount(str(a.id, 'account', 64)),
  cloudflareDisconnect: ctx => ctx.cloudflare.signOut(),
};
export const GIT_OPS = Object.keys(OPS);
/** Account ops never read the project tree and may wait minutes (device flow, the Cloudflare window): no project lane. */
export const ACCOUNT_OPS = new Set(['signIn', 'signInWait', 'signInCancel', 'signOut', 'user', 'repos',
  'cloudflareConnect', 'cloudflareAccount', 'cloudflareSearch', 'cloudflareDisconnect']);

export async function runGitOp(ctx, dir, op, args) {
  if (!Object.hasOwn(OPS, op)) throw encodeError(fail('invalid', `Unknown git op: ${op}`));
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw encodeError(fail('invalid', 'Invalid arguments'));
  const engine = createEngine(dir, { http: ctx.http, onAuth: ctx.onAuth });
  try { return await OPS[op](ctx, engine, args ?? {}); } catch (e) { throw encodeError(e); }
}
