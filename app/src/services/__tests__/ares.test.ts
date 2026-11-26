import { describe, expect, it, vi } from 'vitest';
import { fetchAres, fillFirmaMarkers, hoursSummary, isValidIco, schemaHours, type DayHours } from '../ares';

describe('IČO', () => {
  it('accepts a real checksum and rejects a tampered digit', () => {
    expect(isValidIco('27082440')).toBe(true);
    expect(isValidIco('2708 2440')).toBe(true);
    expect(isValidIco('27082441')).toBe(false);
    expect(isValidIco('123')).toBe(false);
  });

  it('maps an ARES payload and refuses the network kindly', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ico: '27082440', obchodniJmeno: 'Alza.cz a.s.', dic: 'CZ27082440',
      sidlo: { textovaAdresa: 'Jankovcova 1522/53, Holešovice, 17000 Praha 7' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(fetchAres('27082440', fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      nazev: 'Alza.cz a.s.', dic: 'CZ27082440', adresa: 'Jankovcova 1522/53, Holešovice, 17000 Praha 7',
    });
    const down = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchAres('27082440', down as unknown as typeof fetch)).rejects.toMatchObject({ code: 'offline' });
    await expect(fetchAres('27082441')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('fills footer markers and the LocalBusiness block', () => {
    const source = `<p data-sq-firma="nazev">Firma</p><p data-sq-firma="ico">0</p>`
      + `<a data-sq-firma="mapa" href="https://mapy.cz/">Mapa</a>`
      + `<script type="application/ld+json" data-sq-firma-ld>{"@type":"LocalBusiness","name":"Firma"}</script>`;
    const hours: DayHours[] = [
      { id: 'Mo', open: '09:00', close: '17:00', closed: false },
      { id: 'Tu', open: '09:00', close: '17:00', closed: false },
      { id: 'We', open: '09:00', close: '17:00', closed: false },
      { id: 'Th', open: '09:00', close: '17:00', closed: false },
      { id: 'Fr', open: '09:00', close: '17:00', closed: false },
      { id: 'Sa', open: '', close: '', closed: true },
      { id: 'Su', open: '', close: '', closed: true },
    ];
    const next = fillFirmaMarkers(source + `<p data-sq-firma="openingHours">dříve</p><div data-sq-day="Mo"><dt>Pondělí</dt><dd>x</dd></div>`, {
      ico: '27082440', nazev: 'Alza.cz a.s.', dic: 'CZ27082440', adresa: 'Jankovcova 1522/53',
      telefon: '+420 777 000 000', email: 'obchod@alza.cz', website: 'alza.cz', hours, cookies: false,
    });
    expect(next).toContain('>Alza.cz a.s.<');
    expect(next).toContain('>27082440<');
    expect(next).toContain('q=Jankovcova%201522');
    expect(next).toContain('"taxID": "CZ27082440"');
    expect(next).toContain('"Mo 09:00-17:00"');
    expect(next).not.toContain('Mo-Fr 08:00-17:00');
    expect(next).toContain('>9:00–17:00<');
    expect(next).toContain('Po–Pá 9:00–17:00');
    expect(schemaHours(hours)).toEqual(['Mo 09:00-17:00', 'Tu 09:00-17:00', 'We 09:00-17:00', 'Th 09:00-17:00', 'Fr 09:00-17:00']);
    expect(hoursSummary(hours)).toBe('Po–Pá 9:00–17:00');
    const single = fillFirmaMarkers(`<span data-sq-firma='nazev'>Firma</span>`, {
      ico: '27082440', nazev: 'Alza.cz a.s.', dic: '', adresa: '', telefon: '', email: '', website: '', hours, cookies: false,
    });
    expect(single).toContain('>Alza.cz a.s.<');
    expect(single).not.toContain('>Firma<');
  });
});
