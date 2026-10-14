import type { BrokerInfo } from './providerService';

/** Keep a saved selection; fresh CCXT browsers start with public market data. */
export function defaultBroker(provider: string, brokers: BrokerInfo[], saved?: string): string | undefined {
  if (saved && brokers.some((broker) => broker.id === saved)) return saved;
  if (provider === 'ccxt' && brokers.some((broker) => broker.id === 'kraken')) return 'kraken';
  return brokers[0]?.id;
}
