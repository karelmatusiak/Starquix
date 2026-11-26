// Regression: "write seo" caused a full page build + image regeneration loop
// (2026-07-24). The system prompt must carry the scope guardrail and the
// never-regenerate-images rule; these assertions fail if either is dropped.
import { describe, it, expect } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts/userPrompts';

describe('DEFAULT_SYSTEM_PROMPT guardrails', () => {
  it('pins scope to the literal user request, requested action first', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/SCOPE: do ONLY what the user asked/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/requested action FIRST/);
  });

  it('img placeholders never point at a missing file (placeholder.webp existed in no project: broken images)', () => {
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/placeholder\.webp/);
    expect(DEFAULT_SYSTEM_PROMPT).toContain("src='data:image/svg+xml,");
  });

  it('forbids unrequested imagery and re-generating already-set images', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/ONLY when the user asked for images/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NEVER re-generate or re-apply an image/);
  });

  it('DEFAULT_SYSTEM_PROMPT contains the Connecting Pages playbook', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Connecting Pages');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Czech copy for a small business');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Never invent an IČO');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('reorder_page_elements');
  });

  it('honors the runtime tool set without demanding a perfect SEO score', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/exact capabilities are the tools available in this session/i);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/source edits/i);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/drive the editor's score to 100|keep going until percentage is 100/i);
  });
});
