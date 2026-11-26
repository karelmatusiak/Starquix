/**
 * Existing projects must receive the alignment/spacing fix (owner 2026-09-30):
 * our PostLayout.astro is written once and was never rewritten, so a v1 file
 * kept the collapse-based spacing forever.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { upgradePostLayout, postLayoutSource, planPostLayout, POST_LAYOUT_FILE, POST_LAYOUT_MARKER, SUBTITLE_PICK } from '../postLayoutSource';
import { BODY, COLUMN, HEADER } from '../articleTokens';
import { V1_BODY, V1_COVER_WIDE, V1_SUBTITLE_PICK } from '../articleTokensV1';

/** A real v1 file from a live project — the EARLY variant (no media margin rule). */
const EARLY_V1 = readFileSync(join(__dirname, 'fixtures/PostLayout.v1-early.astro'), 'utf8');
/** The late v1 variant, rebuilt from the frozen literals. */
const LATE_V1 = postLayoutSource(null)
  .replace(POST_LAYOUT_MARKER, 'sq-post-layout-v1')
  .replace(`${COLUMN} ${BODY}`, `${COLUMN} ${V1_BODY}`)
  .replace(HEADER.coverWide, V1_COVER_WIDE)
  .replace(SUBTITLE_PICK, V1_SUBTITLE_PICK);

describe('upgradePostLayout (v1 → current)', () => {
  it.each([['early', EARLY_V1], ['late', LATE_V1]])('%s v1 variant → current body + cover classes, v2 marker', (_n, v1) => {
    expect(v1).toContain('sq-post-layout-v1');
    const out = upgradePostLayout(v1)!;
    expect(out).toContain(`<div class="${COLUMN} ${BODY}">`);
    expect(out).toContain(`'${HEADER.coverWide}'`);
    expect(out).not.toContain(`'${V1_COVER_WIDE}'`);
    expect(out).toContain(POST_LAYOUT_MARKER);
    expect(out).not.toContain('sq-post-layout-v1');
    expect(out).toContain(SUBTITLE_PICK);
  });
  it('a body class the user added keeps their class list', () => {
    const edited = EARLY_V1.replace('pb-16', 'pb-16 bg-amber-50');
    const out = upgradePostLayout(edited)!;
    expect(out).toContain('bg-amber-50');
    expect(out).not.toContain(BODY);
  });
  it('current files are left alone (idempotent)', () => {
    expect(upgradePostLayout(postLayoutSource(null))).toBeNull();
    expect(upgradePostLayout(upgradePostLayout(EARLY_V1)!)).toBeNull();
  });
});
