import { t } from '@/i18n';

// Element-clipboard envelope: versioned JSON riding inside text/html behind a
// data-sq-clipboard sentinel (browsers refuse custom MIME types).
export const CLIPBOARD_VERSION = 1;

/** Plain-JSON mirror of the element fields paste re-creates (subset of ElementData). */
export interface PlainElement {
  id: string; pageId: string; parentId: string | null; index: number;
  type: string;
  componentType?: string; astroSource?: string; instanceType?: string;
  staticMarkup?: string; textContent?: string; slotName?: string;
  attributes?: Record<string, string>;
  classes: Record<string, string[]>;            // base/sm/md/lg/xl/2xl → tokens
  extraFields?: Record<string, unknown>;        // isDrawn, tag, penPath, slotType, …
  classOverrides?: Record<string, unknown>;
  unifiedOverrides?: Record<string, unknown>;
}

export interface PlainBlogSlot {
  collectionId: string;
  settings: Record<string, unknown>;
  bindings: Record<string, string>;
}

export interface CopiedRoot {
  label: string;                                // human text for the plain-text fallback
  html: string;                                 // ALWAYS present: cleaned rendered outerHTML
  doc?:
    | { kind: 'subtree'; elements: PlainElement[] }                       // drawn root, parents-first
    | { kind: 'instance'; element: PlainElement; blogSlot?: PlainBlogSlot | null };
}

export interface CopiedMaster { astroSource: string; markup: string; componentType: string }
export interface CopiedAsset { assetId: string; mime: string; name: string; base64: string | null } // null = oversized, ref carried as-is

export interface ClipboardEnvelope {
  v: number;
  sourceProjectId: string;
  roots: CopiedRoot[];
  masters: CopiedMaster[];
  assets: CopiedAsset[];
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function encodeEnvelopeHtml(env: ClipboardEnvelope): string {
  const b64 = bytesToBase64(new TextEncoder().encode(JSON.stringify(env)));
  const label = env.roots.map(r => r.label).join(', ');
  return `<span data-sq-clipboard="${b64}">${escapeHtml(t('Starquix: {0}', { 0: label }))}</span>`;
}

const SENTINEL_RE = /data-sq-clipboard="([A-Za-z0-9+/=]+)"/;

export function decodeEnvelopeHtml(html: string): ClipboardEnvelope | null {
  const m = SENTINEL_RE.exec(html);
  if (!m) return null;
  try {
    const json = new TextDecoder().decode(base64ToBytes(m[1]));
    const env = JSON.parse(json) as ClipboardEnvelope;
    if (env.v !== CLIPBOARD_VERSION) return null;
    if (!Array.isArray(env.roots) || !Array.isArray(env.masters) || !Array.isArray(env.assets)) return null;
    return env;
  } catch {
    return null;
  }
}
