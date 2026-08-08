import { GoogleFlightsProvider } from './google-flights.js';
import { KayakProvider, MomondoProvider } from './kayak.js';
import { MockProvider } from './mock-provider.js';
import { ProviderRegistry } from './provider.js';
import { SkyscannerProvider } from './skyscanner.js';
import { WizzAirProvider } from './airline-sites.js';

export * from './provider.js';
export { GoogleFlightsProvider } from './google-flights.js';
export { KayakProvider, MomondoProvider } from './kayak.js';
export { SkyscannerProvider } from './skyscanner.js';
export { AirlineSiteProvider, WizzAirProvider } from './airline-sites.js';
export { MockProvider } from './mock-provider.js';

/**
 * Live sources in priority order. Google Flights first (broadest coverage, most reliable to
 * automate), then the aggregators, then airline sites which are narrow but authoritative.
 */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(new GoogleFlightsProvider())
    .register(new SkyscannerProvider())
    .register(new KayakProvider())
    .register(new MomondoProvider())
    .register(new WizzAirProvider());
}

/** Offline registry used by `--mock` and by the end-to-end tests. */
export function createMockRegistry(): ProviderRegistry {
  return new ProviderRegistry().register(new MockProvider());
}
