/**
 * Our PostLayout.astro is upgraded on open only when its MARKER is older
 * (upgradePostLayout). So any change to what postLayoutSource writes must bump
 * POST_LAYOUT_MARKER and freeze the old literals in FROZEN_LAYOUTS — otherwise
 * shipped projects keep the old look forever (happened 2026-09: v1 BODY changed
 * without a bump). When this fails: bump the marker, freeze, update both values.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { postLayoutSource, POST_LAYOUT_MARKER } from '../postLayoutSource';

describe('PostLayout marker ratchet', () => {
  it('generated layout hash is pinned to the current marker', () => {
    // both shapes the scaffold writes: standalone and wrapping a site layout
    const out = postLayoutSource(null) + postLayoutSource({ name: 'Layout', importPath: '../layouts/Layout.astro' });
    const sha = createHash('sha256').update(out).digest('hex').slice(0, 16);
    expect({ marker: POST_LAYOUT_MARKER, sha }).toEqual({ marker: 'sq-post-layout-v3', sha: '5b6121d91bbab720' });
  });
});
