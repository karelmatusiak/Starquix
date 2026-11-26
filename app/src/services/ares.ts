// Czech company lookup for the site footer. The public ARES REST API sends
// Access-Control-Allow-Origin: *, so the editor can call it from the renderer.
// https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}

export type DayId = 'Mo' | 'Tu' | 'We' | 'Th' | 'Fr' | 'Sa' | 'Su';

export interface DayHours {
  id: DayId;
  open: string;
  close: string;
  closed: boolean;
}

export const DAY_LABEL: Record<DayId, string> = {
  Mo: 'Pondělí', Tu: 'Úterý', We: 'Středa', Th: 'Čtvrtek', Fr: 'Pátek', Sa: 'Sobota', Su: 'Neděle',
};

const DAY_SHORT: Record<DayId, string> = {
  Mo: 'Po', Tu: 'Út', We: 'St', Th: 'Čt', Fr: 'Pá', Sa: 'So', Su: 'Ne',
};

export const DEFAULT_HOURS: DayHours[] = [
  { id: 'Mo', open: '08:00', close: '17:00', closed: false },
  { id: 'Tu', open: '08:00', close: '17:00', closed: false },
  { id: 'We', open: '08:00', close: '17:00', closed: false },
  { id: 'Th', open: '08:00', close: '17:00', closed: false },
  { id: 'Fr', open: '08:00', close: '17:00', closed: false },
  { id: 'Sa', open: '09:00', close: '12:00', closed: false },
  { id: 'Su', open: '', close: '', closed: true },
];

export interface Firma {
  ico: string;
  nazev: string;
  dic: string;
  adresa: string;
  telefon: string;
  email: string;
  website: string;
  hours: DayHours[];
  cookies: boolean;
}

function clock(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function shownClock(value: string): string {
  return value.replace(/^0(\d)/, '$1');
}

/** Schema.org openingHours, one entry per open day. Closed days are omitted. */
export function schemaHours(hours: DayHours[]): string[] {
  return hours.flatMap((day) => {
    const open = clock(day.open);
    const close = clock(day.close);
    return day.closed || !open || !close ? [] : [`${day.id} ${open}-${close}`];
  });
}

/** A short Czech line, grouping days that share the same hours. */
export function hoursSummary(hours: DayHours[]): string {
  const groups: Array<{ from: DayId; to: DayId; text: string }> = [];
  for (const day of hours) {
    const open = clock(day.open);
    const close = clock(day.close);
    const text = day.closed || !open || !close ? 'zavřeno' : `${shownClock(open)}–${shownClock(close)}`;
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = day.id;
    else groups.push({ from: day.id, to: day.id, text });
  }
  return groups
    .filter((group) => group.text !== 'zavřeno')
    .map((group) => `${group.from === group.to ? DAY_SHORT[group.from] : `${DAY_SHORT[group.from]}–${DAY_SHORT[group.to]}`} ${group.text}`)
    .join(', ');
}

function dayText(day: DayHours): string {
  const open = clock(day.open);
  const close = clock(day.close);
  return day.closed || !open || !close ? 'zavřeno' : `${shownClock(open)}–${shownClock(close)}`;
}

export type AresFailure = 'invalid' | 'not-found' | 'offline';

const ARES = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/';

/** IČO checksum (weights 8…2, check digit 11 − (sum % 11), with 10 → 0 and 11 → 1). */
export function isValidIco(raw: string): boolean {
  const ico = raw.replace(/\s/g, '');
  if (!/^\d{8}$/.test(ico)) return false;
  const digits = ico.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += digits[i] * (8 - i);
  const mod = sum % 11;
  let check = 11 - mod;
  if (check === 10) check = 0;
  else if (check === 11) check = 1;
  return digits[7] === check;
}

interface AresSidlo {
  textovaAdresa?: string;
  nazevUlice?: string;
  cisloDomovni?: number;
  cisloOrientacni?: number;
  nazevObce?: string;
  psc?: number | string;
}

interface AresBody {
  ico?: string;
  obchodniJmeno?: string;
  dic?: string;
  sidlo?: AresSidlo;
}

function addressOf(sidlo: AresSidlo | undefined): string {
  if (!sidlo) return '';
  if (sidlo.textovaAdresa) return sidlo.textovaAdresa;
  const street = [sidlo.nazevUlice, sidlo.cisloDomovni, sidlo.cisloOrientacni].filter(Boolean).join(' ');
  const city = [sidlo.psc, sidlo.nazevObce].filter(Boolean).join(' ');
  return [street, city].filter(Boolean).join(', ');
}

export async function fetchAres(raw: string, fetchImpl: typeof fetch = fetch): Promise<Firma> {
  const ico = raw.replace(/\s/g, '');
  if (!isValidIco(ico)) {
    const error = new Error('invalid') as Error & { code: AresFailure };
    error.code = 'invalid';
    throw error;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${ARES}${ico}`, { headers: { Accept: 'application/json' } });
  } catch {
    const error = new Error('offline') as Error & { code: AresFailure };
    error.code = 'offline';
    throw error;
  }
  if (response.status === 404) {
    const error = new Error('not-found') as Error & { code: AresFailure };
    error.code = 'not-found';
    throw error;
  }
  if (!response.ok) {
    const error = new Error('offline') as Error & { code: AresFailure };
    error.code = 'offline';
    throw error;
  }
  const body = await response.json() as AresBody;
  return {
    ico: body.ico || ico,
    nazev: body.obchodniJmeno || '',
    dic: body.dic || '',
    adresa: addressOf(body.sidlo),
    telefon: '',
    email: '',
    website: '',
    hours: DEFAULT_HOURS.map((day) => ({ ...day })),
    cookies: false,
  };
}

const MARKERS = ['nazev', 'ico', 'dic', 'adresa'] as const;

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replace `data-sq-firma` text, the map link and the LocalBusiness block. */
export function fillFirmaMarkers(source: string, firma: Firma): string {
  let out = source;
  for (const key of MARKERS) {
    const value = String(firma[key] ?? '');
    if (!value) continue;
    const re = new RegExp(`(<[a-zA-Z0-9]+\\b[^>]*data-sq-firma=["']${key}["'][^>]*>)[\\s\\S]*?(</[a-zA-Z0-9]+>)`);
    out = out.replace(re, `$1${escapeText(value)}$2`);
  }
  for (const key of ['telefon', 'email', 'website'] as const) {
    const value = key === 'website' ? firma.website.replace(/^https?:\/\//, '') : firma[key];
    out = out.replace(new RegExp(`(<[a-zA-Z0-9]+\\b[^>]*data-sq-firma=["']${key}["'][^>]*>)[\\s\\S]*?(</[a-zA-Z0-9]+>)`), `$1${escapeText(value)}$2`);
  }
  out = out.replace(/(<a\b[^>]*data-sq-firma=["']email["'][^>]*href=["'])mailto:[^"']*(["'])/, `$1mailto:${firma.email}$2`);
  const phoneHref = firma.telefon.replace(/[^\d+]/g, '');
  out = out.replace(/(<a\b[^>]*data-sq-firma=["']telefon["'][^>]*href=["'])tel:[^"']*(["'])/, `$1tel:${phoneHref}$2`);
  const site = /^https?:\/\//.test(firma.website) ? firma.website : (firma.website ? `https://${firma.website}` : '');
  out = out.replace(/(<a\b[^>]*data-sq-firma=["']website["'][^>]*href=["'])[^"']*(["'])/, `$1${site}$2`);
  for (const day of firma.hours) {
    out = out.replace(
      new RegExp(`(<[a-zA-Z0-9]+\\b[^>]*data-sq-day=["']${day.id}["'][^>]*>[\\s\\S]*?<dd\\b[^>]*>)[\\s\\S]*?(</dd>)`),
      `$1${escapeText(dayText(day))}$2`,
    );
  }
  const summary = hoursSummary(firma.hours);
  out = out.replace(/(<[a-zA-Z0-9]+\b[^>]*data-sq-firma=["']openingHours["'][^>]*>)[\s\S]*?(<\/[a-zA-Z0-9]+>)/, `$1${escapeText(summary)}$2`);
  if (firma.adresa) {
    const href = `https://mapy.cz/zakladni?q=${encodeURIComponent(firma.adresa)}`;
    out = out.replace(/(<a\b[^>]*data-sq-firma=["']mapa["'][^>]*href=["'])[^"']*(["'])/, `$1${href}$2`);
  }
  out = out.replace(/data-sq-cookies="(?:on|off)"/, `data-sq-cookies="${firma.cookies ? 'on' : 'off'}"`);
  out = out.replace(/(<script type="application\/ld\+json" data-sq-firma-ld>)[\s\S]*?(<\/script>)/, (_all, open, close) => {
    const data = {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: firma.nazev,
      taxID: firma.dic,
      url: site,
      telephone: firma.telefon,
      email: firma.email,
      address: { '@type': 'PostalAddress', streetAddress: firma.adresa, addressCountry: 'CZ' },
      openingHours: schemaHours(firma.hours),
    };
    return `${open}${JSON.stringify(data, null, 2)}${close}`;
  });
  return out;
}
