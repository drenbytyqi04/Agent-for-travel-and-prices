# ✈️ Flight Search Agent

Një AI travel assistant që kontrollon Google Chrome, kërkon fluturime reale në disa burime,
krahason çmimet, verifikon më të lirin dhe kthen një përgjigje të strukturuar me link rezervimi.

```
$ npm run agent -- "Më gjej fluturimin më të lirë nga Prishtina për në Gjermani gjatë shtatorit"

✈️ Fluturimi më i lirë

Nga: Prishtinë (PRN)
Për: Stuttgart (STR)
Data e nisjes: 15 Shtator 2026
Kthimi: One-way

💰 Çmimi: €49 ✅ (i verifikuar)
👤 Për: 1 person
🛫 Kompania: Wizz Air
🔄 Direkt
⏱️ Kohëzgjatja: 2h 20min
🧳 Bagazhi: 1 personal item

🔗 Rezervimi:
Hap ofertën:
https://…
```

## Fillimi i shpejtë

Kërkohet **Node.js ≥ 20**.

```bash
git clone -b claude/flight-search-agent-0u7opa \
  https://github.com/drenbytyqi04/Agent-for-travel-and-prices.git
cd Agent-for-travel-and-prices
npm install

# 1) Provo menjëherë, pa browser dhe pa rrjet — të dhëna demo:
npm run agent -- --mock "Nga Prishtina në Berlin më 15 shtator"

# 2) Për kërkime reale duhet një browser (një herë të vetme):
npm run browser

# 3) Kërkim real:
npm run agent -- "Më gjej fluturimin më të lirë nga Prishtina për në Gjermani gjatë shtatorit"

# Modaliteti interaktiv:
npm run agent
```

`npm run browser` shkarkon Chromium-in e Playwright-it. Nëse ke tashmë Google Chrome ose Chromium
të instaluar dhe preferon ta përdorësh atë, kaloje këtë hap — agjenti e gjen vetë; ose trego
shtegun me `FLIGHT_AGENT_CHROME_PATH=/rruga/te/chrome`.

> Herën e parë me faqe reale, përdor `--headed --log-level debug` që ta shohësh browser-in duke
> punuar dhe të kuptosh menjëherë nëse një burim bllokohet.

## Çfarë bën

| Kërkesa juaj | Çfarë ndodh |
|---|---|
| `"…nga Prishtina për në Berlin më 15 shtator"` | Një kërkim i vetëm, i verifikuar. |
| `"…për në Gjermani"` | Krahason 6 aeroporte gjermane dhe rekomandon më të lirin (§7). |
| `"…gjatë shtatorit"` / `"muajin tjetër"` | Provon disa kombinime datash dhe kthen datat më të lira (§8). |
| `"për 4 ditë, gjeje datat më të lira"` | Kërkim fleksibël me kohëzgjatje fikse. |
| `"të premten dhe kthimin të dielën"` | Zgjidh ditët e javës në data konkrete. |
| `"vetëm direkt"`, `"business"`, `"2 persona"`, `"me bagazh"` | Filtra dhe preferenca. |

Preferencat mbahen mend gjatë sesionit: thuaj njëherë *"gjithmonë economy"* dhe kërkimet e
mëvonshme e përdorin pa pyetur (§10). Asgjë nuk ruhet në disk.

## Opsionet e CLI-së

```
--mock                 Të dhëna demo, pa rrjet
--headed               Chrome me dritare të dukshme
--json                 Output i strukturuar
--diagnostics          Cilat burime u konsultuan dhe cilat dështuan
--no-verify            Mos hap ofertën për verifikim çmimi
--only a,b             google_flights | skyscanner | kayak | momondo | wizzair
--exclude a,b          Përjashto burime
--origin "Prishtina"   Origjina e paracaktuar
--currency EUR         Valuta e krahasimit
--max-destinations N   Aeroporte për kërkim sipas shtetit (default 6)
--max-date-pairs N     Kombinime datash për kërkim fleksibël (default 5)
--concurrency N        Tabe browser-i njëkohësisht (default 3)
--log-level L          silent | error | warn | info | debug
```

Në modalitetin interaktiv: `/prefs`, `/clear`, `/help`, `/exit`.

## Hostimi në Vercel

Repoja është e gatshme për Vercel (`public/` + `api/`) — pa build step dhe pa varësi npm në
funksionin serverless, kështu që deploy-i zgjat pak sekonda.

**Mënyra e rekomanduar — lidh repon (deploy automatik në çdo push):**

1. Hap [vercel.com/new](https://vercel.com/new) dhe importo `Agent-for-travel-and-prices`.
2. Te **Branch**, zgjidh `claude/flight-search-agent-0u7opa` (ose bëj merge në `main` më parë).
3. Shtyp **Deploy**. Nuk ka nevojë të ndryshosh asnjë cilësim — `vercel.json` i ka të gjitha.

**Ose nga terminali:**

```bash
npx vercel --prod
```

Linku që merr funksionon kurdo, nga çdo pajisje. Kërkimet janë të lidhshme:
`https://linku-yt.vercel.app/?q=Nga%20Prishtina%20n%C3%AB%20Berlin%20m%C3%AB%2015%20shtator`
Ka edhe API: `GET /api/search?q=…` kthen JSON.

### Çfarë bën faqja e hostuar — dhe çfarë jo

Vercel-i ekzekuton funksione serverless afatshkurtra, nga IP datacenter-i që faqet e fluturimeve i
bllokojnë. Prandaj **kërkimi real me browser nuk bëhet dot nga Vercel-i**. Ndarja është kjo:

| | Vercel | Worker (kompjuteri yt ose një host me kontejnerë) |
|---|---|---|
| Kupton kërkesën në gjuhë natyrale | ✅ | ✅ |
| Zgjeron "Gjermani" → 6 aeroporte | ✅ | ✅ |
| Zgjeron datat fleksibile | ✅ | ✅ |
| Linqe të thella për çdo burim e çdo datë | ✅ | ✅ |
| Lexon çmime reale nga faqet | ❌ | ✅ |
| Verifikon çmimin duke hapur ofertën | ❌ | ✅ |

Edhe vetëm me Vercel faqja është plotësisht e përdorshme: kupton kërkesën dhe të jep linqet e
gatshme për Google Flights, Skyscanner, Kayak, Momondo dhe Wizz Air — për çdo aeroport dhe çdo
datë kandidate. Klikon njërin dhe je te rezultatet reale.

### Çmime reale përmes një worker-i

Ekzekuto worker-in aty ku ke një proces të qëndrueshëm dhe një IP normale:

```bash
WORKER_MOCK=1 npm run worker                        # provo lidhjen me të dhëna demo (sekonda)
WORKER_TOKEN=një-fjalëkalim-i-gjatë npm run worker  # i vërteti, dëgjon në :8787
```

Bëje të arritshëm nga interneti (`ngrok http 8787`, ose deploy në Railway/Render/Fly.io), pastaj
shto në Vercel → Settings → Environment Variables:

| Variabli | Vlera |
|---|---|
| `WORKER_URL` | `https://adresa-e-worker-it` |
| `WORKER_TOKEN` | i njëjti fjalëkalim si më sipër |

Pas kësaj kutia **"Çmime reale"** në faqe kthen çmime të verifikuara. Nëse worker-i është i fikur,
faqja vazhdon të japë linqet normalisht dhe e thotë hapur që çmimet reale nuk u morën.

### Variabla mjedisi për Vercel

| Variabli | Default | Efekti |
|---|---|---|
| `DEFAULT_ORIGIN` | `Prishtina` | Origjina kur përdoruesi s'e përmend. |
| `DEFAULT_CURRENCY` | `EUR` | Valuta e linqeve. |
| `MAX_DESTINATIONS` | `6` | Aeroporte për kërkim sipas shtetit. |
| `MAX_DATE_PAIRS` | `5` | Kombinime datash për kërkim fleksibël. |
| `WORKER_URL` / `WORKER_TOKEN` | — | Aktivizojnë çmimet reale. |

## Arkitektura

Detajet e plota janë te [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
Teksti i përdoruesit
   → Planner (NLU shqip/anglisht)      → FlightRequest
   → FlightSearchAgent                 → zgjeron destinacionet + datat
   → Provider Registry                 → Google Flights, Skyscanner, Kayak, Momondo, Wizz Air
   → PriceComparator                   → dedupe + renditje sipas çmimit total
   → PriceVerifier                     → hap ofertën, rilexon çmimin
   → ResultFormatter                   → përgjigjja
```

### Shtimi i një burimi të ri

Implemento `FlightProvider` (ose zgjero `BaseProvider`) dhe regjistroje:

```ts
export class MyProvider extends BaseProvider {
  readonly id = 'my_provider';
  readonly name = 'My Provider';
  override readonly priority = 25;

  buildSearchUrl(task: SearchTask): string { /* URL që riprodhon kërkimin */ }
  async search(task: SearchTask, context: ProviderContext): Promise<FlightResult[]> { /* … */ }
}

createDefaultRegistry().register(new MyProvider());
```

`BaseProvider.runSearch` e mbështjell `search` në mënyrë që një burim i dështuar të mos e ndalë
kërkimin — gabimi raportohet dhe agjenti vazhdon me burimet e tjera.

## Verifikimi i çmimit (§5)

Çmimet në listat e kërkimit janë reklama: vjetërohen, përjashtojnë tarifa, dhe shpesh janë për
person kur ju kërkuat për tre. Prandaj agjenti hap ofertën më të lirë dhe rilexon çmimin. Rezultati
etiketohet gjithmonë:

| Etiketa | Kuptimi |
|---|---|
| `✅ (i verifikuar)` | Faqja e ofertës u hap dhe çmimi përputhet. |
| `⚠️ (i verifikuar; i listuar ishte X)` | Çmimi ndryshoi — raportohet ai i verifikuari. |
| `❓ / (i paverifikuar)` | Oferta nuk u lexua dot. Trajtoje si orientues. |

Nëse çmimi nuk verifikohet dot, agjenti e thotë hapur: *"Çmimi nuk mund të verifikohej në mënyrë
të sigurt."* Çmime, data ose linqe nuk shpiken kurrë.

## Siguria (§16)

- **Read/search-only.** Agjenti nuk rezervon dhe nuk paguan asgjë.
- **Pa kredenciale.** Nuk kërkon, ruan apo dërgon fjalëkalime ose të dhëna pagese.
- **CAPTCHA nuk anashkalohet.** Kur një faqe kërkon verifikim njerëzor, burimi shënohet i bllokuar
  dhe kërkimi vazhdon diku tjetër.
- **Pa ekzekutim kodi të panjohur.** JavaScript-i i faqeve mbetet brenda sandbox-it të browser-it;
  asgjë nga faqja nuk arrin te sistemi.
- **Memorje minimale.** Vetëm preferenca kërkimi, vetëm në RAM, vetëm për sesionin.

## Konfigurimi me variabla mjedisi

| Variabli | Efekti |
|---|---|
| `FLIGHT_AGENT_CHROME_PATH` | Shtegu i browser-it kur autodetektimi dështon. |
| `FLIGHT_AGENT_HEADED=1` | Hap Chrome me dritare. |
| `FLIGHT_AGENT_LOG_LEVEL` | `silent`…`debug`. |
| `FLIGHT_AGENT_SCREENSHOTS=1` | Ruan screenshot-e në `screenshots/` kur një faqe bllokon. |
| `FLIGHT_AGENT_PROXY` / `HTTPS_PROXY` | Proxy për browser-in. |
| `FLIGHT_AGENT_FX_RATES` | Kurse këmbimi, p.sh. `{"base":"EUR","rates":{"USD":1.08}}`. |
| `ANTHROPIC_API_KEY` | Aktivizon interpretimin opsional me Claude për kërkesa që rregullat nuk i mbulojnë. |

Pa `FLIGHT_AGENT_FX_RATES`, rezultatet në valuta të tjera nuk konvertohen — dhe as nuk
krahasohen gabimisht: ato përjashtohen nga renditja dhe raportohen veçmas.

## Testimi

```bash
npm test              # 205 teste unit + integrim me browser real (fixture lokal)
npm run test:live     # RUN_LIVE=1 — godet faqet reale; i ngadaltë, opsional
npm run typecheck
```

Testet ndahen në tre nivele:

1. **Unit** — parser-at, datat, valutat, URL-të, krahasimi, formatimi. Pa rrjet, pa browser.
2. **Browser** — Chromium i vërtetë kundrejt një serveri fixture lokal, që mban të ndershëm
   selektorët e Google Flights dhe detektimin e CAPTCHA/bllokimit.
3. **Live** — kundrejt faqeve reale, i kaluar si default (`RUN_LIVE=1` për ta aktivizuar).

## Kufizimet e njohura

- Faqet e fluturimeve ndryshojnë DOM-in pa njoftim. Selektorët janë të mbrojtur me alternativa dhe
  një burim i prishur nuk e ndal kërkimin, por provider-at e veçantë mund të kenë nevojë për
  përditësim me kalimin e kohës.
- Skyscanner, Kayak dhe Momondo bllokojnë automatizimin agresivisht. Google Flights është burimi
  më i qëndrueshëm dhe prandaj ka prioritetin më të lartë.
- Katalogu i aeroporteve është i kuruar (Gjermania + tregjet fqinje), jo global. Shtimi i një
  tregu të ri është shtim rreshtash te `src/utils/airports.ts`.
