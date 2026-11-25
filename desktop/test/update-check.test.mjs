import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createUpdateCheck, feedUrl, installerSuffix, RELEASES } from '../src/update-check.mjs';
// Update notifier, notify only (docs/plans/2026-11-10-update-notifier-design.md — the ledger rows are cited per test).
const HOUR = 3_600_000;
const release = (tag, assets = [`Starquix-${tag.replace(/^v/, '')}-arm64.dmg`], extra = {}) =>
  ({ tag_name: tag, draft: false, prerelease: false, assets: assets.map(name => ({ name })), ...extra });
const ok = body => async () => ({ ok: true, status: 200, json: async () => body });
const page = tag => `https://github.com/karelmatusiak/Starquix/releases/tag/${tag}`;
const mac = (fetch, options = {}) => {
  const emit = vi.fn();
  return { emit, check: createUpdateCheck({ fetch, current: '0.3.2', platform: 'darwin', arch: 'arm64', feed: RELEASES, emit, ...options }) };
};
let errors;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T12:00:00Z')); errors = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('which release counts', () => {
  it('a newer release with this machine\'s installer is the update, its page built from the tag; equal or older is none (rows 13-15)', async () => {
    for (const [tags, latest, tag] of [[['v0.3.3'], '0.3.3', 'v0.3.3'], [['v0.3.2'], null], [['v0.3.1', 'v0.2.0'], null],
      [['v0.3.3', 'v0.4.0'], '0.4.0', 'v0.4.0'], [['0.3.5'], '0.3.5', '0.3.5']]) {
      const { check } = mac(ok(tags.map(t => release(t))));
      await check.tick();
      expect(check.state()).toEqual({ current: '0.3.2', latest, page: tag ? page(tag) : null });
    }
  });
  it('compares versions as numbers, not strings: 0.10.0 is above 0.9.9', async () => {
    const { check } = mac(ok([release('v0.10.0')]), { current: '0.9.9' });
    await check.tick();
    expect(check.state().latest).toBe('0.10.0');
  });
  it('a newer release without an installer for this machine never hides an older one that has it (row 16)', async () => {
    const { check } = mac(ok([release('v0.3.4', ['Starquix-Setup-0.3.4.exe']), release('v0.3.3')]));
    await check.tick();
    expect(check.state().latest).toBe('0.3.3');
  });
  it('skips prereleases, drafts and tags that are not plain versions, and keeps the rest (rows 39-41)', async () => {
    const { check } = mac(ok([release('v0.5.0', undefined, { prerelease: true }), release('v0.4.9', undefined, { draft: true }),
      release('v0.4.8-beta.1', ['Starquix-0.4.8-beta.1-arm64.dmg']), release(' v0.4.7'), { tag_name: 7 }, null, release('v0.3.3')]));
    await check.tick();
    expect(check.state().latest).toBe('0.3.3');
  });
  it('the installer suffixes are electron-builder\'s artifact names in desktop/package.json (row 42)', () => {
    const { build } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const name = (pattern, arch, ext) => pattern.replace('${productName}', 'Starquix').replace('${version}', '0.3.3').replace('${arch}', arch).replace('${ext}', ext);
    expect(name(build.mac.artifactName, 'arm64', 'dmg').endsWith(installerSuffix('darwin', 'arm64'))).toBe(true);
    expect(name(build.mac.artifactName, 'x64', 'dmg').endsWith(installerSuffix('darwin', 'x64'))).toBe(true);
    expect(name(build.nsis.artifactName, 'x64', 'exe').endsWith(installerSuffix('win32', 'x64'))).toBe(true);
    expect(name(build.nsis.artifactName, 'arm64', 'exe').endsWith(installerSuffix('win32', 'arm64'))).toBe(true);
    expect(name(build.nsis.artifactName, 'arm64', 'exe').endsWith(installerSuffix('win32', 'x64'))).toBe(false);
    expect(name(build.linux.artifactName, 'x86_64', 'AppImage').endsWith(installerSuffix('linux', 'x64'))).toBe(true); // ${arch} of an x64 AppImage
    expect(name(build.linux.artifactName, 'arm64', 'AppImage').endsWith(installerSuffix('linux', 'arm64'))).toBe(true);
    expect(installerSuffix('linux', 'ia32')).toBe(null);
  });
});

describe('failures keep the last answer (rows 18-21, 31-38, 43)', () => {
  const failures = {
    'HTTP 403': async () => ({ ok: false, status: 403, json: async () => ({ message: 'rate limited' }) }),
    'offline': async () => { throw new TypeError('net::ERR_INTERNET_DISCONNECTED'); },
    'captive portal HTML': async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    'not a list': ok({ tag_name: 'v9.9.9' }),
  };
  for (const [name, failing] of Object.entries(failures)) {
    it(`${name}: nothing changes, nothing is emitted, nothing throws`, async () => {
      const fetch = vi.fn(ok([release('v0.3.3')]));
      const { check, emit } = mac(fetch);
      await check.tick();
      expect(check.state().latest).toBe('0.3.3');
      fetch.mockImplementation(failing);
      vi.setSystemTime(Date.now() + 6 * HOUR);
      await expect(check.tick()).resolves.toBeUndefined();
      expect(check.state().latest).toBe('0.3.3');
      expect(emit).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalled();
    });
  }
  it('a good answer without the shown release relabels, an empty list clears (rows 17-19)', async () => {
    const fetch = vi.fn(ok([release('v0.3.4'), release('v0.3.3')]));
    const { check, emit } = mac(fetch);
    await check.tick();
    fetch.mockImplementation(ok([release('v0.3.3')])); vi.setSystemTime(Date.now() + 6 * HOUR); await check.tick();
    fetch.mockImplementation(ok([])); vi.setSystemTime(Date.now() + 6 * HOUR); await check.tick();
    expect(emit.mock.calls.map(([s]) => s.latest)).toEqual(['0.3.4', '0.3.3', null]);
  });
});

describe('schedule', () => {
  it('first check 5 s after start, then every 6 h on an hourly tick; a failure retries the next hour (rows 11, 27-28)', async () => {
    const fetch = vi.fn(ok([release('v0.3.3')]));
    const { check } = mac(fetch);
    check.start();
    await vi.advanceTimersByTimeAsync(4_999); expect(fetch).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(1); // +5 s
    await vi.advanceTimersByTimeAsync(6 * HOUR - 5_000); expect(fetch).toHaveBeenCalledTimes(1); // ticks at 1-6 h: < 6 h since the answer
    await vi.advanceTimersByTimeAsync(HOUR); expect(fetch).toHaveBeenCalledTimes(2); // the 7 h tick is the first due one
    fetch.mockImplementation(async () => { throw new TypeError('offline'); });
    await vi.advanceTimersByTimeAsync(6 * HOUR); expect(fetch).toHaveBeenCalledTimes(3); // 13 h: due, fails
    await vi.advanceTimersByTimeAsync(HOUR); expect(fetch).toHaveBeenCalledTimes(4); // the failure retried an hour later
  });
  it('a clock that went back counts as due (row 29)', async () => {
    const fetch = vi.fn(ok([]));
    const { check } = mac(fetch);
    await check.tick();
    vi.setSystemTime(Date.now() - 24 * HOUR);
    await check.tick();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('a tick during a check sends no second request; a hung request is aborted after 15 s (rows 32, 45)', async () => {
    const fetch = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const { check } = mac(fetch);
    const first = check.tick();
    vi.setSystemTime(Date.now() + 7 * HOUR);
    await check.tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    expect(check.state().latest).toBeNull();
    const second = check.tick(); // the hung request no longer blocks checks (fetch runs before tick's first await)
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000); await second;
  });
  it('asks with the GitHub JSON type, no credentials of its own (row 60)', async () => {
    const fetch = vi.fn(ok([]));
    await mac(fetch).check.tick();
    expect(fetch).toHaveBeenCalledWith(RELEASES, expect.objectContaining({ headers: { Accept: 'application/vnd.github+json' } }));
    expect(RELEASES).toBe('https://api.github.com/repos/karelmatusiak/Starquix/releases?per_page=10');
  });
});

describe('when there is no check at all (rows 3-5, 9-10)', () => {
  it('the feed: unset → the releases repo only when packaged; an http(s) URL → that URL; anything else → off', () => {
    expect(feedUrl(undefined, true)).toBe(RELEASES);
    expect(feedUrl(undefined, false)).toBeNull();
    expect(feedUrl('http://127.0.0.1:4100/releases', false)).toBe('http://127.0.0.1:4100/releases');
    expect(feedUrl('https://example.test/r', true)).toBe('https://example.test/r');
    for (const off of ['off', '', 'file:///etc/passwd', 'starquix://app/x', 'javascript:alert(1)']) expect(feedUrl(off, true)).toBeNull();
  });
  for (const [name, options] of Object.entries({
    'no feed (unpacked)': { feed: null },
    'no installer for this machine (FreeBSD)': { platform: 'freebsd', arch: 'x64' },
    'a version that is not plain x.y.z': { current: '0.4.0-beta.1' },
  })) {
    it(`${name}: no request, no timer, the state still carries the version`, async () => {
      const fetch = vi.fn(ok([release('v9.9.9')]));
      const { check } = mac(fetch, options);
      check.start();
      await check.tick();
      await vi.advanceTimersByTimeAsync(24 * HOUR);
      expect(fetch).not.toHaveBeenCalled();
      expect(check.state()).toEqual({ current: options.current ?? '0.3.2', latest: null, page: null });
    });
  }
});
