# Webdílna

Vizuální editor webů v Astro. Desktopová aplikace pro macOS, Windows a Linux.

Webdílna vychází z open-source projektu [Starquix](https://github.com/Mayhopar/Starquix) (MIT).

Webdílna otevře složku projektu Astro a ukáže skutečný web na plátně. Vyberete prvek a změníte ho v panelu Návrh; změna se zapíše do souborů. Projekt zůstane obyčejná složka Astro a Tailwind na vašem počítači.

Název a logo Starquix vytvořil Oleg Maykhopar a licence MIT se na ně nevztahuje. Webdílna je proto nepoužívá jako vlastní značku.

## Sestavování s agenty

V zabudovaném terminálu spusťte Claude Code, Codex nebo jiného CLI agenta, nebo si v aplikaci pište s vlastním API klíčem (Anthropic, OpenAI, OpenRouter nebo místní Ollama). Agenti upravují otevřený projekt přes zabudovaný MCP server a změny se ukážou na plátně.

## Úpravy ručně

Text, obrázky, barvy a rozvržení měníte na plátně nebo v panelu Návrh.

## Publikace a export

Publikace na Cloudflare nebo GitHub Pages, na Netlify nebo Vercel přes repozitář na GitHubu, nebo export složky projektu.

## Co je v aplikaci

- **CMS.** Píšete příspěvky a publikujete je jako stránky.
- **SEO.** Titulky, popisy a skóre každé stránky.
- **Proměnné.** Barvu změníte jednou a projeví se všude.
- **Místní soubory.** Web jsou obyčejné soubory Astro ve složce na počítači.

## Jazyk rozhraní

Rozhraní je česky. Anglický text ve zdrojáku je klíč katalogu `app/src/i18n/cs.json`; chybějící překlad se ukáže anglicky. Testy běží s anglickými větami (`VITEST`), aby šly sloučit změny z upstreamu. Technické názvy (SEO, CMS, Astro, Cloudflare, GitHub Pages) zůstávají.

Vnitřní identifikátory (`starquix`, složka `.starquix`, klíče v localStorage, spouštěč `~/.starquix-mcp`) se nemění schválně.

## Aktualizace z upstreamu

Upstream je [Mayhopar/Starquix](https://github.com/Mayhopar/Starquix). Jednou ho připojte a pak slučujte do větve `main` tohoto forku:

```bash
git remote add upstream https://github.com/Mayhopar/Starquix.git
git fetch upstream
git checkout main
git merge upstream/main
```

Po sloučení pusťte testy (`cd app && npm run test:run` a `cd desktop && npm test`). Nové anglické věty v rozhraní se v aplikaci ukážou anglicky, dokud je nepřidáte do `app/src/i18n/cs.json`. Klíč je přesně ta anglická věta, hodnota je český překlad. Plugin `app/scripts/i18n-plugin.mjs` při `vite` a `vite build` obalí viditelné literály voláním `sqT`; Vitest ten plugin nenačítá.

Neslučujte tento fork do repozitáře Mayhopar/Starquix.

## Vývoj

```bash
git clone https://github.com/karelmatusiak/Starquix.git
cd Starquix
npm ci
npm ci --prefix preview-template
npm ci --prefix desktop
npm --prefix app run dev -- --host 127.0.0.1 --port 3061 --strictPort   # editor, který načítá desktopová aplikace
```

V druhém terminálu:

```bash
cd desktop && npm run deps && npm run mcp && npm start
```

Potřeba je Node.js 22.12+ a npm 10. Aplikace běží na macOS, Windows a Linuxu. Sestavení pro macOS má v `desktop/package.json` připravený hardened runtime; podepisování ani notarizace se nenastavují.

Vývojové spuštění nasměruje `~/.starquix-mcp` (spouštěč agentů) na tento checkout. Agenti nainstalované aplikace pak používají vývojový relay, dokud nainstalovanou aplikaci nespustíte znovu.

Testy: `cd app && npm run test:run` a `cd desktop && npm test`.

| Složka | Obsah |
|---|---|
| `app/` | Editor (Vite + React) a katalog `src/i18n/` |
| `desktop/` | Aplikace Electron: každému projektu spouští dev server Astro |
| `preview-template/` | Plugin Vite a most plátna, který se kopíruje do projektu |
| `mcp/` | MCP server pro programovací agenty |
| `scripts/` | Sestavení mostu a snapshotu |
| `fixtures/` | Ukázkový projekt Astro pro testy |
| `docs/` | Architektura, toky dat, návody (anglicky, z upstreamu) |

Zdroj mostu je `app/src/bridge/parts/`. Po změně mostu nebo `preview-template/` spusťte `npm run build:snapshot`.

Opravy chyb potřebují regresní test. Příspěvky do upstreamu: [CONTRIBUTING.md](CONTRIBUTING.md).

## Soukromí

Projekty a API klíče jsou na vašem počítači. Aplikace jde na síť, aby:

- počítala anonymní zobrazení přes [Plausible](https://plausible.io) (bez cookies; `app/src/main.tsx`);
- se na GitHubu podívala, jestli není novější vydání Webdílny (`desktop/src/update-check.mjs`, repozitář `karelmatusiak/Starquix`);
- načetla Google Fonts, když vyberete písmo;
- dosáhla na poskytovatele AI a publikační služby, které připojíte, s vašimi klíči a účty.

Kód a assety třetích stran: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

MIT. Původní oznámení: Copyright (c) 2026 Oleg Maykhopar and Nikita Osadchiy. Úpravy tohoto forku: Copyright (c) 2026 Karel Matusiak. Součásti třetích stran mají vlastní licence ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Název a logo Starquix vytvořil Oleg Maykhopar a licence se na ně nevztahuje; k jejich použití je potřeba jeho souhlas.
