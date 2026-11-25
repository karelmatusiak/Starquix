// Update notifier, notify only (docs/plans/2026-11-10-update-notifier-design.md): main asks the public releases repo for
// the newest release that carries an installer for THIS machine and tells the editor. Nothing is stored; a failed
// check changes nothing and retries an hour later. Auto-install is task-251.
const REPO = 'karelmatusiak/Starquix'; // Webdílna releases. Upstream Starquix builds are a different app.
export const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
const HOUR = 3_600_000; const EVERY = 6 * HOUR; const TIMEOUT = 15_000;
const parse = version => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version); return m && m.slice(1).map(Number); };
const above = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
/** The asset suffix a release must carry for this machine (electron-builder's artifactName); null = nothing ships here. */
const INSTALLERS = { 'darwin-arm64': '-arm64.dmg', 'darwin-x64': '-x64.dmg', 'win32-x64': '-x64.exe', 'win32-arm64': '-arm64.exe',
  'linux-x64': '-x86_64.AppImage', 'linux-arm64': '-arm64.AppImage' }; // AppImage names x64 "x86_64" (builder-util getArtifactArchName)
export const installerSuffix = (platform, arch) => INSTALLERS[`${platform}-${arch}`] ?? null;
/** SQ_UPDATE_FEED: an http(s) URL replaces the feed in any build, anything else turns the check off; unset = the releases
 *  repo, packaged builds only (dev and e2e stay off the network). */
export function feedUrl(env, packaged) {
  if (env === undefined) return packaged ? RELEASES : null;
  try { const url = new URL(env); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
}
export function createUpdateCheck({ fetch, current, platform, arch, feed, emit }) {
  const suffix = installerSuffix(platform, arch); const mine = parse(current);
  const on = !!(feed && suffix && mine);
  let state = { current, latest: null, page: null }; let lastOk = -Infinity; let inFlight = false;
  /** The highest plain-version, non-draft, non-prerelease release above `current` that has this machine's installer.
   *  Its page is built from the checked tag, never taken from the response. */
  const pick = releases => {
    if (!Array.isArray(releases)) throw new Error('The feed is not a list of releases');
    let best = mine; let tag = null;
    for (const r of releases) {
      const version = typeof r?.tag_name === 'string' && !r.draft && !r.prerelease && parse(r.tag_name);
      if (version && above(version, best) && Array.isArray(r.assets) && r.assets.some(a => typeof a?.name === 'string' && a.name.endsWith(suffix))) {
        best = version; tag = r.tag_name;
      }
    }
    return { current, latest: tag && best.join('.'), page: tag && `https://github.com/${REPO}/releases/tag/${tag}` };
  };
  async function tick() {
    const now = Date.now(); const age = now - lastOk; // < 0: the clock went back, so it is due
    if (!on || inFlight || (age >= 0 && age < EVERY)) return;
    inFlight = true; const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('The update check timed out')), TIMEOUT); // a hung request must not block every later check
    try {
      const response = await fetch(feed, { headers: { Accept: 'application/vnd.github+json' }, signal: abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = pick(await response.json());
      lastOk = now;
      if (next.latest !== state.latest) { state = next; emit(state); }
    } catch (error) { console.error('[update check]', error?.message ?? error); } // silent for the user: nothing to act on
    finally { clearTimeout(timer); inFlight = false; }
  }
  return { state: () => state, tick, start() { if (on) { setTimeout(tick, 5_000); setInterval(tick, HOUR); } } };
}
