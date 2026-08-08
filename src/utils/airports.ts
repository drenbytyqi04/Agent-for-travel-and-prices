import { InvalidAirportError } from '../errors.js';
import { deaccent } from './dates.js';

export interface Airport {
  iata: string;
  name: string;
  city: string;
  /** ISO-3166 alpha-2. */
  country: string;
  countryName: string;
  /** Alternative spellings the user might type (Albanian, German, local). */
  aliases: string[];
  /** Rough traffic rank inside its country, 1 = busiest. Used to order fan-out searches. */
  rank: number;
}

/**
 * Curated catalog rather than a full OpenFlights dump: the agent only ever needs the airports it
 * can plausibly search from Kosovo plus the destination markets. Adding a market = adding rows.
 */
export const AIRPORTS: Airport[] = [
  // ── Kosovo & neighbours (origins) ────────────────────────────────────────────────────────────
  { iata: 'PRN', name: 'Prishtina International Airport Adem Jashari', city: 'Prishtinë', country: 'XK', countryName: 'Kosovë', rank: 1, aliases: ['prishtina', 'pristina', 'prishtine', 'prishtina international', 'kosovo'] },
  { iata: 'SKP', name: 'Skopje International Airport', city: 'Shkup', country: 'MK', countryName: 'Maqedoni e Veriut', rank: 1, aliases: ['skopje', 'shkup', 'skopje airport'] },
  { iata: 'TIA', name: 'Tirana International Airport Nënë Tereza', city: 'Tiranë', country: 'AL', countryName: 'Shqipëri', rank: 1, aliases: ['tirana', 'tirane', 'rinas'] },
  { iata: 'OHD', name: 'Ohrid St. Paul the Apostle Airport', city: 'Ohër', country: 'MK', countryName: 'Maqedoni e Veriut', rank: 2, aliases: ['ohrid', 'oher'] },
  { iata: 'INI', name: 'Niš Constantine the Great Airport', city: 'Nish', country: 'RS', countryName: 'Serbi', rank: 2, aliases: ['nis', 'nish', 'nisch'] },
  { iata: 'BEG', name: 'Belgrade Nikola Tesla Airport', city: 'Beograd', country: 'RS', countryName: 'Serbi', rank: 1, aliases: ['belgrade', 'beograd'] },
  { iata: 'POD', name: 'Podgorica Airport', city: 'Podgoricë', country: 'ME', countryName: 'Mal i Zi', rank: 1, aliases: ['podgorica', 'podgorice'] },

  // ── Germany (primary destination market) ─────────────────────────────────────────────────────
  { iata: 'FRA', name: 'Frankfurt Airport', city: 'Frankfurt', country: 'DE', countryName: 'Gjermani', rank: 1, aliases: ['frankfurt', 'frankfurt am main', 'frankfurt main'] },
  { iata: 'MUC', name: 'Munich Airport', city: 'München', country: 'DE', countryName: 'Gjermani', rank: 2, aliases: ['munich', 'munchen', 'muenchen', 'mynih', 'munih'] },
  { iata: 'BER', name: 'Berlin Brandenburg Airport', city: 'Berlin', country: 'DE', countryName: 'Gjermani', rank: 3, aliases: ['berlin', 'brandenburg', 'berlini'] },
  { iata: 'DUS', name: 'Düsseldorf Airport', city: 'Düsseldorf', country: 'DE', countryName: 'Gjermani', rank: 4, aliases: ['dusseldorf', 'duesseldorf', 'dyseldorf'] },
  { iata: 'HAM', name: 'Hamburg Airport', city: 'Hamburg', country: 'DE', countryName: 'Gjermani', rank: 5, aliases: ['hamburg', 'hamburgu'] },
  { iata: 'STR', name: 'Stuttgart Airport', city: 'Stuttgart', country: 'DE', countryName: 'Gjermani', rank: 6, aliases: ['stuttgart', 'shtutgart', 'shtutgard'] },
  { iata: 'CGN', name: 'Cologne Bonn Airport', city: 'Köln', country: 'DE', countryName: 'Gjermani', rank: 7, aliases: ['cologne', 'koln', 'koeln', 'cologne bonn', 'koln bonn', 'bonn'] },
  { iata: 'HAJ', name: 'Hannover Airport', city: 'Hannover', country: 'DE', countryName: 'Gjermani', rank: 8, aliases: ['hannover', 'hanover'] },
  { iata: 'NUE', name: 'Nuremberg Airport', city: 'Nürnberg', country: 'DE', countryName: 'Gjermani', rank: 9, aliases: ['nuremberg', 'nurnberg', 'nuernberg'] },
  { iata: 'LEJ', name: 'Leipzig/Halle Airport', city: 'Leipzig', country: 'DE', countryName: 'Gjermani', rank: 10, aliases: ['leipzig', 'halle', 'leipzig halle'] },
  { iata: 'DRS', name: 'Dresden Airport', city: 'Dresden', country: 'DE', countryName: 'Gjermani', rank: 11, aliases: ['dresden', 'drezden'] },
  { iata: 'FMM', name: 'Memmingen Airport', city: 'Memmingen', country: 'DE', countryName: 'Gjermani', rank: 12, aliases: ['memmingen', 'allgau', 'munich west'] },
  { iata: 'FKB', name: 'Karlsruhe/Baden-Baden Airport', city: 'Karlsruhe', country: 'DE', countryName: 'Gjermani', rank: 13, aliases: ['karlsruhe', 'baden baden', 'baden-baden'] },
  { iata: 'BRE', name: 'Bremen Airport', city: 'Bremen', country: 'DE', countryName: 'Gjermani', rank: 14, aliases: ['bremen'] },
  { iata: 'DTM', name: 'Dortmund Airport', city: 'Dortmund', country: 'DE', countryName: 'Gjermani', rank: 15, aliases: ['dortmund'] },
  { iata: 'FMO', name: 'Münster Osnabrück Airport', city: 'Münster', country: 'DE', countryName: 'Gjermani', rank: 16, aliases: ['munster', 'muenster', 'osnabruck'] },

  // ── Other common European destinations ───────────────────────────────────────────────────────
  { iata: 'ZRH', name: 'Zurich Airport', city: 'Zürich', country: 'CH', countryName: 'Zvicër', rank: 1, aliases: ['zurich', 'zyrih'] },
  { iata: 'GVA', name: 'Geneva Airport', city: 'Gjenevë', country: 'CH', countryName: 'Zvicër', rank: 2, aliases: ['geneva', 'geneve', 'gjeneve'] },
  { iata: 'BSL', name: 'EuroAirport Basel-Mulhouse-Freiburg', city: 'Basel', country: 'CH', countryName: 'Zvicër', rank: 3, aliases: ['basel', 'mulhouse', 'basel mulhouse'] },
  { iata: 'VIE', name: 'Vienna International Airport', city: 'Vjenë', country: 'AT', countryName: 'Austri', rank: 1, aliases: ['vienna', 'wien', 'vjene'] },
  { iata: 'MXP', name: 'Milan Malpensa Airport', city: 'Milano', country: 'IT', countryName: 'Itali', rank: 1, aliases: ['milan', 'milano', 'malpensa'] },
  { iata: 'BGY', name: 'Milan Bergamo Airport', city: 'Bergamo', country: 'IT', countryName: 'Itali', rank: 2, aliases: ['bergamo', 'orio al serio'] },
  { iata: 'FCO', name: 'Rome Fiumicino Airport', city: 'Romë', country: 'IT', countryName: 'Itali', rank: 3, aliases: ['rome', 'roma', 'fiumicino'] },
  { iata: 'LGW', name: 'London Gatwick Airport', city: 'Londër', country: 'GB', countryName: 'Britani e Madhe', rank: 2, aliases: ['gatwick', 'london gatwick', 'london', 'londer'] },
  { iata: 'LTN', name: 'London Luton Airport', city: 'Londër', country: 'GB', countryName: 'Britani e Madhe', rank: 3, aliases: ['luton', 'london luton', 'london', 'londer'] },
  { iata: 'LHR', name: 'London Heathrow Airport', city: 'Londër', country: 'GB', countryName: 'Britani e Madhe', rank: 1, aliases: ['heathrow', 'london heathrow', 'londer', 'london'] },
  { iata: 'CDG', name: 'Paris Charles de Gaulle Airport', city: 'Paris', country: 'FR', countryName: 'Francë', rank: 1, aliases: ['paris', 'charles de gaulle', 'roissy'] },
  { iata: 'BVA', name: 'Paris Beauvais Airport', city: 'Beauvais', country: 'FR', countryName: 'Francë', rank: 2, aliases: ['beauvais', 'paris beauvais'] },
  { iata: 'AMS', name: 'Amsterdam Schiphol Airport', city: 'Amsterdam', country: 'NL', countryName: 'Holandë', rank: 1, aliases: ['amsterdam', 'schiphol'] },
  { iata: 'EIN', name: 'Eindhoven Airport', city: 'Eindhoven', country: 'NL', countryName: 'Holandë', rank: 2, aliases: ['eindhoven'] },
  { iata: 'BRU', name: 'Brussels Airport', city: 'Bruksel', country: 'BE', countryName: 'Belgjikë', rank: 1, aliases: ['brussels', 'bruksel', 'zaventem'] },
  { iata: 'CRL', name: 'Brussels South Charleroi Airport', city: 'Charleroi', country: 'BE', countryName: 'Belgjikë', rank: 2, aliases: ['charleroi', 'brussels charleroi'] },
  { iata: 'ARN', name: 'Stockholm Arlanda Airport', city: 'Stokholm', country: 'SE', countryName: 'Suedi', rank: 1, aliases: ['stockholm', 'arlanda', 'stokholm'] },
  { iata: 'CPH', name: 'Copenhagen Airport', city: 'Kopenhagë', country: 'DK', countryName: 'Danimarkë', rank: 1, aliases: ['copenhagen', 'kopenhage', 'kastrup'] },
  { iata: 'OSL', name: 'Oslo Gardermoen Airport', city: 'Oslo', country: 'NO', countryName: 'Norvegji', rank: 1, aliases: ['oslo', 'gardermoen'] },
  { iata: 'IST', name: 'Istanbul Airport', city: 'Stamboll', country: 'TR', countryName: 'Turqi', rank: 1, aliases: ['istanbul', 'stamboll'] },
  { iata: 'SAW', name: 'Istanbul Sabiha Gökçen Airport', city: 'Stamboll', country: 'TR', countryName: 'Turqi', rank: 2, aliases: ['sabiha', 'sabiha gokcen', 'istanbul', 'stamboll'] },
  { iata: 'BUD', name: 'Budapest Ferenc Liszt Airport', city: 'Budapest', country: 'HU', countryName: 'Hungari', rank: 1, aliases: ['budapest'] },
  { iata: 'ZAG', name: 'Zagreb Franjo Tuđman Airport', city: 'Zagreb', country: 'HR', countryName: 'Kroaci', rank: 1, aliases: ['zagreb'] },
  { iata: 'LJU', name: 'Ljubljana Jože Pučnik Airport', city: 'Ljubljanë', country: 'SI', countryName: 'Slloveni', rank: 1, aliases: ['ljubljana', 'lubjane'] },
  { iata: 'MAD', name: 'Madrid Barajas Airport', city: 'Madrid', country: 'ES', countryName: 'Spanjë', rank: 1, aliases: ['madrid', 'barajas'] },
  { iata: 'BCN', name: 'Barcelona El Prat Airport', city: 'Barcelonë', country: 'ES', countryName: 'Spanjë', rank: 2, aliases: ['barcelona', 'el prat'] },
];

/** Country names in Albanian, English and local language → ISO alpha-2. */
export const COUNTRY_NAMES: Record<string, string> = {
  gjermani: 'DE', gjermania: 'DE', gjermanine: 'DE', germany: 'DE', deutschland: 'DE', de: 'DE',
  zvicer: 'CH', zvicra: 'CH', switzerland: 'CH', schweiz: 'CH',
  austri: 'AT', austria: 'AT', osterreich: 'AT',
  itali: 'IT', italia: 'IT', italy: 'IT',
  france: 'FR', franca: 'FR', francë: 'FR',
  holande: 'NL', hollande: 'NL', netherlands: 'NL', holland: 'NL',
  belgjike: 'BE', belgium: 'BE',
  suedi: 'SE', sweden: 'SE',
  danimarke: 'DK', denmark: 'DK',
  norvegji: 'NO', norway: 'NO',
  turqi: 'TR', turkey: 'TR', turkiye: 'TR',
  britani: 'GB', angli: 'GB', england: 'GB', uk: 'GB', 'united kingdom': 'GB',
  spanje: 'ES', spain: 'ES', espana: 'ES',
  hungari: 'HU', hungary: 'HU',
  kroaci: 'HR', croatia: 'HR',
  slloveni: 'SI', slovenia: 'SI',
  kosove: 'XK', kosovo: 'XK',
  shqiperi: 'AL', albania: 'AL',
};

export const COUNTRY_LABELS_SQ: Record<string, string> = {
  DE: 'Gjermani', CH: 'Zvicër', AT: 'Austri', IT: 'Itali', FR: 'Francë', NL: 'Holandë',
  BE: 'Belgjikë', SE: 'Suedi', DK: 'Danimarkë', NO: 'Norvegji', TR: 'Turqi',
  GB: 'Britani e Madhe', ES: 'Spanjë', HU: 'Hungari', HR: 'Kroaci', SI: 'Slloveni',
  XK: 'Kosovë', AL: 'Shqipëri', MK: 'Maqedoni e Veriut', RS: 'Serbi', ME: 'Mal i Zi',
};

const BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));

const BY_ALIAS = (() => {
  const map = new Map<string, Airport[]>();
  const add = (key: string, airport: Airport) => {
    const normalised = normaliseKey(key);
    if (!normalised) return;
    const existing = map.get(normalised);
    // The same airport reaches a key by several routes ("Berlin" is both its city and an alias);
    // without this guard "berlin" resolves to BER twice and the agent searches it twice.
    if (existing) {
      if (!existing.includes(airport)) existing.push(airport);
    } else {
      map.set(normalised, [airport]);
    }
  };
  for (const airport of AIRPORTS) {
    add(airport.iata, airport);
    add(airport.city, airport);
    add(airport.name, airport);
    for (const alias of airport.aliases) add(alias, airport);
  }
  return map;
})();

function normaliseKey(value: string): string {
  return deaccent(value)
    .toLowerCase()
    .replace(/\b(airport|aeroporti|aeroport|international|intl)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function findAirportByIata(iata: string): Airport | undefined {
  return BY_IATA.get(iata.trim().toUpperCase());
}

/**
 * Resolves free text to airports. A city with several airports (London, Milan, Istanbul) returns
 * all of them, ordered by rank, so the caller can decide whether to search one or all.
 */
export function resolveAirports(query: string): Airport[] {
  const key = normaliseKey(query);
  if (!key) return [];

  const exact = BY_ALIAS.get(key);
  if (exact) return [...exact].sort((a, b) => a.rank - b.rank);

  // Prefix / containment fallback: "frankfur", "berlin brandenburg".
  const partial = AIRPORTS.filter((airport) => {
    const candidates = [airport.iata, airport.city, airport.name, ...airport.aliases].map(normaliseKey);
    return candidates.some((candidate) => candidate.startsWith(key) || key.startsWith(candidate) || candidate.includes(key));
  });
  return partial.sort((a, b) => a.rank - b.rank);
}

/**
 * Exact alias/IATA/city match only — no prefix or containment fallback.
 * The planner scans free text with this so a word like "nis" cannot accidentally match an airport.
 */
export function resolveAirportsExact(query: string): Airport[] {
  const key = normaliseKey(query);
  if (!key) return [];
  const matches = BY_ALIAS.get(key);
  return matches ? [...matches].sort((a, b) => a.rank - b.rank) : [];
}

/** Resolves to exactly one airport, throwing when the text is unusable. */
export function resolveAirport(query: string): Airport {
  const matches = resolveAirports(query);
  if (matches.length === 0) throw new InvalidAirportError(query);
  return matches[0]!;
}

export function resolveCountry(query: string): string | undefined {
  const key = normaliseKey(query);
  if (!key) return undefined;
  if (COUNTRY_NAMES[key]) return COUNTRY_NAMES[key];
  if (/^[A-Z]{2}$/.test(query.trim().toUpperCase()) && COUNTRY_LABELS_SQ[query.trim().toUpperCase()]) {
    return query.trim().toUpperCase();
  }
  return undefined;
}

export function countryLabel(code: string): string {
  return COUNTRY_LABELS_SQ[code.toUpperCase()] ?? code.toUpperCase();
}

/**
 * Airports to fan out to when the user names only a country.
 * Ordered by rank and capped, because every extra airport multiplies the number of browser searches.
 */
export function airportsInCountry(country: string, limit = 11): Airport[] {
  const code = country.trim().toUpperCase();
  return AIRPORTS.filter((airport) => airport.country === code)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

export function airportLabel(airport: Airport): string {
  return `${airport.city} (${airport.iata})`;
}

/** Best-effort reference for an IATA code that is not in the catalog. */
export function airportRef(iata: string, fallbackCity?: string): { airport: string; city: string; country?: string } {
  const known = findAirportByIata(iata);
  if (known) return { airport: known.iata, city: known.city, country: known.country };
  return { airport: iata.toUpperCase(), city: fallbackCity ?? iata.toUpperCase() };
}
