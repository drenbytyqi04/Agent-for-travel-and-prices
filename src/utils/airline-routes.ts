/**
 * Which routes each direct-booking airline actually operates.
 *
 * Pure data, deliberately kept out of `providers/` so that callers who only need to know whether a
 * link is worth offering — the hosted web app, for one — do not have to pull in the browser layer.
 */

/** Wizz Air's Prishtina network (subset relevant to this agent). */
export const WIZZ_PRN_ROUTES: ReadonlySet<string> = new Set([
  'PRN-DTM', 'PRN-FMM', 'PRN-HAM', 'PRN-BER', 'PRN-FKB', 'PRN-HAJ', 'PRN-NUE',
  'PRN-BRE', 'PRN-CGN', 'PRN-FRA', 'PRN-STR', 'PRN-DUS', 'PRN-LEJ', 'PRN-FMO',
  'PRN-BSL', 'PRN-GVA', 'PRN-VIE', 'PRN-BGY', 'PRN-MXP', 'PRN-CRL', 'PRN-EIN',
  'PRN-LTN', 'PRN-BVA', 'PRN-BUD', 'PRN-CPH', 'PRN-ARN', 'PRN-OSL',
]);

/** True when the route is in the set, in either direction. */
export function servesRoute(routes: ReadonlySet<string>, originIata: string, destinationIata: string): boolean {
  return routes.has(`${originIata}-${destinationIata}`) || routes.has(`${destinationIata}-${originIata}`);
}

/** True when the airport appears anywhere in the route set. */
export function touchesAirport(routes: ReadonlySet<string>, iata: string): boolean {
  for (const route of routes) {
    const [from, to] = route.split('-');
    if (from === iata || to === iata) return true;
  }
  return false;
}
