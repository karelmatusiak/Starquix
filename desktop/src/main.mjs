// Electron main: owns project dirs and Astro children; the editor renderer gets
// a scoped preload API, never Node, never an instance secret.
import { app, BrowserWindow, ipcMain, Menu, net, protocol, safeStorage, session, shell } from 'electron';
import fsp from 'node:fs/promises';
import gitHttp from 'isomorphic-git/http/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorResponse, originOf, resolveEditor, strays } from './editor.mjs';
import { freePath } from './downloads.mjs';
import { probeInvisible, probeWindowOptions } from './probe-mode.mjs';
import { createProjects, projectDirFor } from './projects.mjs';
import { createAuth } from './git/auth.mjs';
import { createGithub } from './git/github.mjs';
import { createPages } from './git/pages.mjs';
import { createCloudflare } from './cloudflare.mjs';
import { buildSite, checkSite } from './site-build.mjs';
import { ACCOUNT_OPS, createGitContext, runGitOp } from './git/ops.mjs';
import { createInstance, prepareSpare, closeSpare } from './supervisor.mjs';
import { createSessions, validateSender, requestPath, responseBytes } from './ipc.mjs';
import { createQuitFlush, ignoreVetoWhileLeaving } from './quit-flush.mjs';
import { createMcpHost } from './agents.mjs';
import { createTerminals, shellSpec } from './terminal.mjs';
import { createWatchers } from './watch.mjs';
import { installCrashLog } from './crash-log.mjs';
import { createUpdateCheck, feedUrl } from './update-check.mjs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { t } from './i18n.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
app.setName('Webdílna');
if (probeInvisible(process.env) && process.platform === 'darwin') app.setActivationPolicy('accessory');
if (process.env.SQ_USER_DATA) app.setPath('userData', path.resolve(process.env.SQ_USER_DATA));
// Uncaught main-process exceptions → <userData>/logs/main.log, never Electron's modal dialog (crash-log.mjs).
// Node's default 10 frames cut off what triggered the 2026-11-09 one; keep enough to see the trigger.
Error.stackTraceLimit = 50;
installCrashLog(path.join(app.getPath('userData'), 'logs', 'main.log'));
// Cloudflare ledger 12: Google refuses sign-in in "embedded" browsers by user agent; popups only get the app-wide fallback.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|Starquix[\w-]*|Webd[ií]lna[\w-]*)\/\S+/gi, '');
process.env.SQ_COMPILE_CACHE ??= path.join(app.getPath('userData'), 'compile-cache'); // inherited by every Astro child
// Packaged: the bundled editor build on starquix://app. Unpacked (npm start, e2e):
// the dev editor on a loopback port — :3061 by default, SQ_EDITOR_URL picks another so parallel sessions don't share one.
const resources = app.isPackaged ? process.resourcesPath : path.resolve(here, '../..');
const { editorUrl, editorOrigin } = resolveEditor({ isPackaged: app.isPackaged, env: process.env });
process.env.SQ_EDITOR_ORIGIN = editorOrigin; // inherited by every Astro child: its only CORS origin (wrapper.mjs)
if (app.isPackaged) protocol.registerSchemesAsPrivileged([{ scheme: 'starquix',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const projectsRoot = process.env.SQ_PROJECTS_ROOT ?? path.join(app.getPath('home'), 'Webdílna');
const projects = createProjects(projectsRoot);
let win; let allowQuit = false; let quitting = false;
/** Navigation stays on the editor, in every frame (the canvas also on its loopback preview: editor.mjs `strays`); web
 *  links open in the system browser; editor pages (help) open in a plain window that never gets the preload. */
function guard(contents) {
  const openWeb = url => { if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url); };
  contents.setWindowOpenHandler(({ url }) => {
    if (originOf(url) === editorOrigin) {
      const help = new BrowserWindow({ width: 900, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
      guard(help.webContents); void help.loadURL(url);
    } else openWeb(url);
    return { action: 'deny' };
  });
  contents.on('will-frame-navigate', event => { if (strays(event, editorOrigin)) { event.preventDefault(); openWeb(event.url); } });
  contents.on('will-attach-webview', event => event.preventDefault());
}
const depsDir = process.env.SQ_RUNTIME_DEPS ?? (app.isPackaged ? path.join(resources, 'runtime-deps/node_modules')
  : path.resolve(here, '../runtime-deps/node_modules'));
// MCP-mode terminal (terminal.mjs). node-pty loads on first use: a broken native module only costs the terminal.
const require = createRequire(import.meta.url);
let shellHook = null; // agents.mjs hook files, written below; without them the shell still runs, unconnected
const terminals = createTerminals({
  spawnPty: (cwd, cols, rows) => { const s = shellSpec(process.env, shellHook);
    // The relay up before the user's agent: the editor pairs, which fills the catalogue an agent lists once at startup.
    // Windows: Node never runs the .cmd launcher without a shell — run what an agent's MCP config runs.
    if (mcpHost.server) execFile(mcpHost.server.command, [...mcpHost.server.args, 'tools'], { env: { ...process.env, ...mcpHost.server.env }, windowsHide: true }, () => {});
    else execFile(mcpHost.launcher, ['tools'], () => {});
    return require('node-pty').spawn(s.file, s.args, { name: 'xterm-256color', cols, rows, cwd, env: s.env }); },
  emit: (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(`sq:${channel}`, ...args); },
});
// Agent multiplayer (2026-11-08): the open project is watched for outside edits whether or not its terminal is open.
const watchers = createWatchers({ read: (id, rels) => projects.read(id, rels),
  emit: (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(`sq:${channel}`, ...args); } });
const sessions = createSessions({ projects,
  spawn: options => createInstance({ ...options, templateDir: path.join(resources, 'preview-template'), depsDir, spares: true }),
  emit: state => { if (win && !win.isDestroyed()) win.webContents.send('sq:state', state); },
  onOpen: id => { terminals.keepOnly(id); watchers.keepOnly(id, projectDirFor(projectsRoot, id)); },
  onClose: id => { terminals.release(id); watchers.release(id); },
});
function handle(name, fn) {
  ipcMain.handle(`sq:${name}`, (event, ...args) => {
    validateSender(event, win.webContents, editorOrigin);
    if (!process.env.SQ_IPC_LOG) return fn(...args);
    // SQ_IPC_LOG=1: one JSON line per call (scripts/profile.mjs aggregates them per step).
    const t0 = performance.now(); const r = fn(...args);
    void Promise.resolve(r).catch(() => {}).finally(() => console.log('[sq-ipc]', JSON.stringify({ at: Date.now(), name,
      route: name === 'fetch' ? `${args[3]} ${String(args[4]).replace(/path=[^&]*&?/, '').replace(/[?&]$/, '')}` : '', ms: Math.round(performance.now() - t0) })));
    return r;
  });
}
// The relay CLI for coding agents ships inside the app (mcp/starquix-mcp.mjs,
// scripts/build-mcp.mjs) and runs on the app's own runtime (runAsNode fuse):
// no npm package, no Node install. Zero-code pairing (agents.mjs): the editor
// dials the relay identity in ~/.starquix-mcp/daemon.json. The connect prompt
// runs the launcher — the same command an agent's MCP config registers.
const mcpScript = app.isPackaged ? path.join(resources, 'mcp/starquix-mcp.mjs') : path.resolve(here, '../mcp/starquix-mcp.mjs');
const mcpHost = createMcpHost({ relayHome: process.env.STARQUIX_MCP_HOME || path.join(os.homedir(), '.starquix-mcp'),
  execPath: process.execPath, script: mcpScript });
let mcpCommand = `"${mcpHost.launcher}"`;
try { mcpHost.refreshLauncher(); } catch (error) {
  console.error('[mcp launcher]', error);
  mcpCommand = `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${mcpScript}"`; // no launcher: the inline form still works for `sq`
}
try { shellHook = mcpHost.writeShellHook(); } catch (error) { console.error('[terminal hook]', error); }
ipcMain.on('sq:mcp-command', event => {
  try { validateSender(event, win.webContents, editorOrigin); event.returnValue = mcpCommand; }
  catch { event.returnValue = null; }
});
// Windows: the relay as an agent's MCP config must run it (an .exe + env, agents.mjs); null elsewhere (the launcher is that).
ipcMain.on('sq:mcp-server', event => {
  try { validateSender(event, win.webContents, editorOrigin); event.returnValue = mcpHost.server; }
  catch { event.returnValue = null; }
});
handle('mcp-code', () => mcpHost.code());
handle('mcp-rotate', () => mcpHost.rotate());
mcpHost.watch(code => { if (win && !win.isDestroyed()) win.webContents.send('sq:mcp-code', code); });
// Update notifier, notify only (update-check.mjs): an in-memory session — no cookies, no disk cache, the system proxy.
const updates = createUpdateCheck({ fetch: (url, init) => session.fromPartition('sq-update-check').fetch(url, init),
  current: app.getVersion(), platform: process.platform, arch: process.arch, feed: feedUrl(process.env.SQ_UPDATE_FEED, app.isPackaged),
  emit: state => { if (win && !win.isDestroyed()) win.webContents.send('sq:update', state); } });
handle('update-state', () => updates.state());
handle('exists', id => projects.exists(id));
handle('start', (id, lease, seed) => sessions.start(id, lease, seed));
handle('stop', (id, lease) => sessions.stop(id, lease));
handle('snapshot', async (id, lease) => { const owner = sessions.get(id, lease); await owner.ready; return projects.snapshot(id); });
handle('status', (id, lease) => sessions.get(id, lease).instance?.state() ?? { phase: 'starting' });
// Versions + GitHub (docs/plans/2026-10-07-git-versions-design.md) and Cloudflare: each sign-in lives in userData,
// encrypted by the OS keychain (safeStorage) — never plaintext.
const keychain = { decrypt: b => safeStorage.decryptString(b), encrypt: s => {
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('No OS keychain to store the sign-in'), { code: 'no-keychain' });
  return safeStorage.encryptString(s);
} };
const fileStore = name => {
  const file = () => path.join(app.getPath('userData'), name);
  return { read: () => fsp.readFile(file()).catch(() => null), write: b => fsp.writeFile(file(), b, { mode: 0o600 }),
    clear: () => fsp.rm(file(), { force: true }) };
};
const gitAuth = createAuth({ store: fileStore('github-token.bin'), crypto: keychain });
const github = createGithub({ token: () => gitAuth.token() });
// Cloudflare (docs/plans/2026-10-16-cloudflare-one-click-design.md C4): the sign-in window has its own signed-in session,
// never the editor's: https only, popups stay in it, never the preload (permissions and downloads are refused in whenReady).
const CLOUDFLARE_PARTITION = 'persist:cloudflare';
let signInWin = null;
const cloudflareWindows = {
  /** Resolves when the window closes; `onNavigate(url)` true = stop there and close. One window at a time. */
  open(url, { onNavigate } = {}) {
    if (signInWin) { signInWin.window.focus(); return signInWin.closed; }
    const w = new BrowserWindow({ width: 1100, height: 820, parent: win,
      webPreferences: { partition: CLOUDFLARE_PARTITION, sandbox: true, contextIsolation: true } });
    const guardSignIn = contents => {
      const stop = event => {
        if (onNavigate?.(event.url)) { event.preventDefault(); w.close(); } else if (!event.url.startsWith('https://')) event.preventDefault();
      };
      contents.on('will-navigate', stop); contents.on('will-redirect', stop);
      // Popup logins (Google, GitHub, Apple) may open blank first; their navigation is still https-only (guarded here).
      contents.setWindowOpenHandler(({ url: next }) => ({ action: next === 'about:blank' || next.startsWith('https://') ? 'allow' : 'deny' }));
      contents.on('did-create-window', child => guardSignIn(child.webContents));
      contents.on('will-attach-webview', event => event.preventDefault());
    };
    guardSignIn(w.webContents);
    const closed = new Promise(resolve => w.on('closed', () => { signInWin = null; resolve(); }));
    signInWin = { window: w, closed };
    void w.loadURL(url);
    return closed;
  },
  clear: () => session.fromPartition(CLOUDFLARE_PARTITION).clearStorageData(),
};
// e2e only (never packaged): a signed-in stub account against a local fake Cloudflare API, which also serves the hosts it
// deployed (`/__site/<host>/<path>`): "Live" checks the real uploaded bytes there too.
const cloudflareTestApi = !app.isPackaged && process.env.SQ_CLOUDFLARE_TEST_API;
let stubBlob = JSON.stringify({ access: 'e2e', refresh: 'e2e', expiresAt: Date.now() + 365 * 86_400_000,
  accounts: [{ id: 'e2e-account', name: 'E2E' }], account: 'e2e-account' });
const cloudflare = cloudflareTestApi
  ? createCloudflare({ api: cloudflareTestApi, clientId: 'e2e',
    fetch: (url, init) => { const u = new URL(url); return fetch(String(url).startsWith(cloudflareTestApi) ? url : `${cloudflareTestApi}/__site/${u.host}${u.pathname}`, init); },
    store: { read: async () => stubBlob, write: async v => { stubBlob = v; }, clear: async () => { stubBlob = null; } },
    crypto: { encrypt: s => s, decrypt: s => s }, windows: { open: async () => {}, clear: async () => {} } })
  : createCloudflare({ store: fileStore('cloudflare-token.bin'), crypto: keychain, windows: cloudflareWindows,
    sandbox: !app.isPackaged && process.env.SQ_CLOUDFLARE_SANDBOX === '1' }); // live check 6: the Registrar sandbox
// e2e only (never packaged): a signed-in stub whose "GitHub" is a local git http server.
const testRemote = !app.isPackaged && process.env.SQ_GIT_TEST_REMOTE;
const git = testRemote
  ? createGitContext({ http: gitHttp, cloudflare, build: buildSite, typeCheck: checkSite,
    auth: { token: async () => 'e2e', user: async () => ({ login: 'e2e', name: 'E2E', email: 'e2e@example.com', avatarUrl: '', id: 1 }),
      start: async () => { throw new Error('stub'); }, cancel() {}, signOut: async () => {} },
    github: { createRepo: async ({ name }) => ({ owner: 'e2e', repo: name, cloneUrl: `${testRemote}/${name}.git`, htmlUrl: '' }),
      deployStatus: async () => ({ state: 'none', url: null }),
      // Publish into (SQ_GIT_TEST_REPOS = the test server's repos, default branch main); the preview's REST tree is empty.
      repos: async () => (process.env.SQ_GIT_TEST_REPOS ?? '').split(',').filter(Boolean)
        .map(repo => ({ owner: 'e2e', repo, private: false, pushedAt: new Date().toISOString() })),
      repo: async (_owner, name) => ({ owner: 'e2e', repo: name, cloneUrl: `${testRemote}/${name}.git`, htmlUrl: '', defaultBranch: 'main',
        private: false, archived: false, push: true, size: 1, hasPages: false }),
      tree: async () => ({ truncated: false, entries: [] }), text: async () => null, deployedBy: async () => null } })
  : createGitContext({ auth: gitAuth, github, http: gitHttp, pages: createPages({ github }), cloudflare, build: buildSite, typeCheck: checkSite });
handle('git', (id, lease, op, args) => {
  sessions.get(id, lease); // only the editor document that owns the open project
  const run = () => runGitOp(git, projectDirFor(projectsRoot, id), op, args);
  return ACCOUNT_OPS.has(op) ? run() : projects.serial(id, run);
});
// The open project's shell: the lease proves the editor document owns the project; it starts in the seeded folder.
handle('terminal-attach', async (id, lease) => { const owner = sessions.get(id, lease); await owner.seeded;
  return terminals.attach(id, projectDirFor(projectsRoot, id)); });
handle('terminal-input', (id, lease, data) => { sessions.get(id, lease); terminals.input(id, data); });
handle('terminal-resize', (id, lease, cols, rows) => { sessions.get(id, lease); terminals.resize(id, cols, rows); });
handle('abort', (id, lease, requestId) => { sessions.get(id, lease).requests.get(requestId)?.abort(); });
const HEADERS = ['accept', 'content-type', 'cache-control', 'x-sq-mutation-session', 'x-sq-mutation-id'];
handle('fetch', async (id, lease, requestId, kind, route, init) => {
  const owner = sessions.get(id, lease);
  if (typeof requestId !== 'string' || owner.requests.has(requestId)) throw new Error('Invalid request id');
  const method = init?.method ?? 'GET'; const safeRoute = requestPath(kind, route, method);
  if (init?.body && (!(init.body instanceof ArrayBuffer) || init.body.byteLength > 25 * 1024 * 1024)) throw new Error('Request too large');
  const headers = new Headers(init?.headers);
  for (const key of headers.keys()) if (!HEADERS.includes(key)) throw new Error(`Unapproved header: ${key}`);
  const cancel = new AbortController(); owner.requests.set(requestId, cancel);
  try {
    await owner.ready;
    sessions.get(id, lease);
    const response = await owner.instance.request(safeRoute, { method, headers, body: init?.body,
      signal: AbortSignal.any([cancel.signal, owner.controller.signal]) });
    return { status: response.status, statusText: response.statusText, headers: [...response.headers], body: await responseBytes(response) };
  } finally {
    owner.requests.delete(requestId);
    cancel.abort(); // done: drops the finished request's signal listeners now, not at the 120 s deadline
  }
});
function appMenu() {
  const about = { role: 'about', label: t('About Webdílna') };
  const file = process.platform === 'darwin'
    ? { role: 'close', label: t('Close Window') }
    : { role: 'quit', label: t('Quit Webdílna') };
  return [
    ...(process.platform === 'darwin' ? [{
      label: 'Webdílna',
      submenu: [
        about,
        { type: 'separator' },
        { role: 'services', label: t('Services') },
        { type: 'separator' },
        { role: 'hide', label: t('Hide Webdílna') },
        { role: 'hideOthers', label: t('Hide Others') },
        { role: 'unhide', label: t('Show All') },
        { type: 'separator' },
        { role: 'quit', label: t('Quit Webdílna') },
      ],
    }] : []),
    { label: t('File'), submenu: [file] },
    { label: t('Edit'), submenu: [
      { role: 'undo', label: t('Undo') },
      { role: 'redo', label: t('Redo') },
      { type: 'separator' },
      { role: 'cut', label: t('Cut') },
      { role: 'copy', label: t('Copy') },
      { role: 'paste', label: t('Paste') },
      { role: 'selectAll', label: t('Select All') },
    ] },
    { label: t('View'), submenu: [
      { role: 'reload', label: t('Reload') },
      { role: 'forceReload', label: t('Force Reload') },
      { role: 'toggleDevTools', label: t('Toggle Developer Tools') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('Actual Size') },
      { role: 'zoomIn', label: t('Zoom In') },
      { role: 'zoomOut', label: t('Zoom Out') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('Toggle Full Screen') },
    ] },
    { label: t('Window'), submenu: [
      { role: 'minimize', label: t('Minimize') },
      { role: 'zoom', label: t('Zoom') },
      ...(process.platform === 'darwin'
        ? [{ type: 'separator' }, { role: 'front', label: t('Bring All to Front') }]
        : [{ role: 'close', label: t('Close') }]),
    ] },
    { label: t('Help'), submenu: [about] },
  ];
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  // SQ_QUIT_LOG=1: one line per quit stage (e2e: where a quit stops — Windows ConPTY, 2026-11-10).
  const quitLog = process.env.SQ_QUIT_LOG ? stage => console.log('[sq-quit]', stage, Date.now()) : () => {};
  // Quit / close handshake (instant-edit P2): the renderer pushes the input it still holds and waits for the lane to
  // accept it BEFORE the sessions stop (a push at unload is refused by stopped sessions). <= 2 s, then quit anyway.
  const quitFlush = createQuitFlush({ getWindow: () => win, ipcMain, editorOrigin });
  let closing = false, closeFlushed = false;
  app.on('before-quit', event => {
    if (allowQuit) return; event.preventDefault(); quitting = true;
    quitLog('flush');
    void quitFlush.flush().then(() => {
      quitLog('terminals'); terminals.closeAll(); quitLog('watchers'); watchers.closeAll(); quitLog('sessions');
      return sessions.closeAll();
    }).then(() => { quitLog('spare'); return closeSpare(); }).then(() => { quitLog('quit'); allowQuit = true; app.quit(); }, error => {
      console.error('[desktop shutdown]', error); allowQuit = true; app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    // macOS app menu → About Webdílna. Windows has no about panel — the Projects footer carries the same line.
    app.setAboutPanelOptions({
      applicationName: 'Webdílna',
      applicationVersion: app.getVersion(),
      copyright: 'Webdílna © 2026 Karel Matusiak. Starquix © 2026 Oleg Maykhopar a Nikita Osadchiy. MIT.',
      credits: 'Webdílna vychází z open-source projektu Starquix (MIT).\nhttps://github.com/Mayhopar/Starquix',
      website: 'https://github.com/Mayhopar/Starquix',
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));
    if (app.isPackaged) {
      const root = path.join(resources, 'editor');
      protocol.handle('starquix', request => editorResponse(root, request.url, href => net.fetch(href)));
    }
    // Windows/Linux: the default menu bar (File Edit View…) stays hidden until Alt; its shortcuts keep working.
    win = new BrowserWindow({ title: 'Webdílna', width: 1440, height: 900, minWidth: 900, minHeight: 600, autoHideMenuBar: true, ...probeWindowOptions(process.env), webPreferences: {
      preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    guard(win.webContents);
    if (probeInvisible(process.env)) { win.setIgnoreMouseEvents(true); win.showInactive(); }
    // The red button / Windows X: the editor flushes what it holds first (a Cmd-Q already did, in before-quit).
    win.on('close', event => {
      if (closeFlushed || quitting) return;
      event.preventDefault(); closing = true;
      void quitFlush.flush().then(() => { closeFlushed = true; if (!win.isDestroyed()) win.close(); });
    });
    // A beforeunload veto (unsaved work) must not keep the window open while the app is leaving: the flush pushed it.
    win.webContents.on('will-prevent-unload', ignoreVetoWhileLeaving(() => quitting || closing));
    win.on('closed', () => app.quit()); // a leftover help window never keeps the app alive
    // A new editor document (reload / navigation) can never call stop for the
    // old one's leases: its async unmount dies with the page. Release them here.
    win.webContents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) void sessions.releaseAll();
    });
    // P0: a renderer crash needs an app relaunch; Astro child crashes self-recover.
    win.webContents.on('render-process-gone', () => { void sessions.closeAll(); });
    // Chrome-like: Export's blob download lands in Downloads without a modal dialog, beside a same-named file, never over it.
    win.webContents.session.on('will-download', (_event, item) => {
      const file = freePath(path.join(process.env.SQ_DOWNLOADS ?? app.getPath('downloads'), path.basename(item.getFilename())));
      item.setSavePath(file);
      // No browser download bubble here: bounce the Dock's Downloads stack (macOS).
      item.once('done', (_e, state) => { if (state === 'completed') app.dock?.downloadFinished(file); });
    });
    // Copy/paste and durable storage only, and only for the editor itself.
    const allowed = (permission, origin) => origin === editorOrigin
      && ['clipboard-read', 'clipboard-sanitized-write', 'persistent-storage'].includes(permission);
    win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(allowed(permission, originOf(details.requestingUrl ?? contents.getURL()))));
    win.webContents.session.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, originOf(origin)));
    // The Cloudflare sign-in session (ledger 68): no downloads; no permissions but clipboard writes (copy buttons).
    const signInSession = session.fromPartition(CLOUDFLARE_PARTITION);
    signInSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    signInSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    signInSession.on('will-download', event => event.preventDefault());
    // A spare Astro runner preloads while the user picks a project (not during editor startup).
    win.webContents.once('did-finish-load', () => { setTimeout(() => { if (!quitting) prepareSpare({ depsDir }); }, 1000); updates.start(); });
    void win.loadURL(editorUrl);
  });
}
