# Flight Search Agent — Arkitektura dhe Plani i Punës

## 1. Qëllimi

Një agjent që merr një kërkesë në gjuhë natyrale (shqip ose anglisht), e kthen atë në një
`FlightRequest` të strukturuar, hap Google Chrome përmes Playwright, kërkon në disa burime
fluturimesh, krahason çmimet reale, verifikon më të lirin dhe kthen një përgjigje të formatuar
me link sa më direkt.

```
User text
   │
   ▼
[ Planner ]  ── NLU (rule-based + opsionalisht LLM) ──►  FlightRequest
   │
   ▼
[ FlightSearchAgent ]
   │  ├── zgjeron destinacionin ("Gjermani" → 11 aeroporte)
   │  ├── zgjeron datat (fleksibël → kandidatë datash)
   │  └── ndan punën në "search tasks"
   ▼
[ Provider Registry ]  ──►  GoogleFlights │ Skyscanner │ Kayak │ Momondo │ AirlineSites
   │                              (secili përdor BrowserContext të vetin)
   ▼
[ PriceComparator ]  ── dedupe + rendit sipas çmimit total
   │
   ▼
[ PriceVerifier ]  ── hap ofertën më të lirë, rilexon çmimin final
   │
   ▼
[ ResultFormatter ]  ──►  përgjigje për përdoruesin
```

## 2. Vendimet kryesore

| Vendim | Arsyeja |
|---|---|
| TypeScript + Node 22 (ESM) | Skemat në specifikim janë TypeScript; Playwright ka mbështetje first-class. |
| Playwright (Chromium/Chrome) | Faqet e fluturimeve janë plotësisht dinamike; scraping statik nuk funksionon. |
| Provider interface + registry | Burime të reja shtohen pa prekur agjentin. |
| Një `BrowserContext` për provider | Izolim i cookies/consent, mundëson paralelizëm të kontrolluar. |
| URL-first, form-fill si fallback | URL-të e ndërtuara janë më të shpejta e më të qëndrueshme; forma përdoret kur URL-ja s'aplikohet. |
| Parser rule-based si default, LLM opsional | Funksionon pa API key; me `ANTHROPIC_API_KEY` bëhet më i zgjuar. |
| Read-only by default | Asnjë rezervim/pagesë pa konfirmim eksplicit. |

## 3. Modulet

```
src/
├── agent/
│   ├── planner.ts              NL → FlightRequest (rule-based + LLM opsional)
│   ├── flight-search-agent.ts  orkestrimi i plotë
│   ├── price-comparator.ts     dedupe, renditje, më i liri për qytet/datë
│   ├── price-verifier.ts       hap ofertën, verifikon çmimin final
│   └── result-formatter.ts     output i formatuar (shqip)
├── browser/
│   ├── playwright-manager.ts   lifecycle i browser-it, context-e, anti-bot hardening
│   ├── chrome-controller.ts    API e nivelit të lartë: navigim, retry, detektim blloku
│   └── page-interaction.ts     helpers: click/type/consent/screenshot, të sigurt
├── providers/
│   ├── provider.ts             FlightProvider interface + BaseProvider + registry
│   ├── google-flights.ts
│   ├── skyscanner.ts
│   ├── kayak.ts
│   ├── momondo.ts
│   ├── airline-sites.ts        Wizz Air etj.
│   └── mock-provider.ts        për teste/demo pa rrjet
├── models/
│   ├── flight-request.ts
│   └── flight-result.ts
├── utils/
│   ├── airports.ts             katalog aeroportesh + rezolucion qytet/shtet
│   ├── dates.ts                parsim/format datash, muaj shqip, ditë jave
│   ├── currency.ts             parsim çmimesh, normalizim valutash
│   ├── url-builder.ts          search URL për çdo burim
│   └── logger.ts
├── memory/
│   └── session-memory.ts       preferencat e përdoruesit gjatë sesionit
├── errors.ts                   gabime të tipizuara
└── cli.ts                      REPL + one-shot
```

## 4. Plani i punës (hap pas hapi)

1. **Scaffolding** — package.json, tsconfig, vitest, lint. ✅
2. **Models & errors** — `FlightRequest`, `FlightResult`, gabime të tipizuara. ✅
3. **Utils** — aeroporte, data, valuta, URL builder. Teste unit. ✅
4. **Browser layer** — PlaywrightManager, ChromeController, PageInteraction. ✅
5. **Provider interface + Google Flights (MVP)**. ✅
6. **Planner (NLU)** + memory. Teste unit. ✅
7. **Comparator + Formatter**. Teste unit. ✅
8. **Agent orchestration** (destinacion i zgjeruar, data fleksibile). ✅
9. **Provider-a shtesë**: Skyscanner, Kayak, Momondo, Wizz Air. ✅
10. **Price verification**. ✅
11. **CLI** + dokumentim. ✅

## 5. Strategjia e testimit

- **Unit** (pa rrjet): parser, data, valuta, url-builder, comparator, formatter, memory.
- **Contract**: çdo provider testohet kundrejt HTML fixture-ve statike për parsimin e rezultateve.
- **Live** (opsionale, `RUN_LIVE=1`): hap Chrome-in real dhe godet burimet. Kalohen automatikisht
  në CI ose kur rrjeti bllokohet.
- **Mock provider**: mundëson demonstrimin end-to-end të pipeline-it pa rrjet (`--mock`).

## 6. Kufizime të njohura

- Faqet e fluturimeve ndryshojnë DOM-in shpesh; selektorët janë të mbrojtur me disa alternativa
  dhe dështimi i një provider-i nuk e ndal kërkimin.
- CAPTCHA **nuk anashkalohet** — provider-i shënohet `blocked` dhe kalohet te burimi tjetër.
- Nëse çmimi nuk verifikohet dot, raportohet qartë si i paverifikuar; çmimet nuk shpiken kurrë.
