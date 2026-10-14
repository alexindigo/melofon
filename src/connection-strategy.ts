// Leaf transport policy: no discovery, playback, storage or protocol imports.
export type ConnectionStrategy = 'melofon' | 'owntone' | 'audiostation';
export const CONNECTION_STRATEGY_DEFAULT_KEY =
  'airplay.connectionStrategy.default';
export const DEFAULT_CONNECTION_STRATEGY: ConnectionStrategy = 'melofon';
export const CONNECTION_STRATEGIES = Object.freeze(
  {
    melofon: Object.freeze({ idle: 'retire', discontinuity: 'retire' }),
    owntone: Object.freeze({ idle: 'hold', discontinuity: 'flush' }),
    audiostation: Object.freeze({ idle: 'retire', discontinuity: 'retire' }),
  } as const,
);
export function isConnectionStrategy(
  value: unknown,
): value is ConnectionStrategy {
  return value === 'melofon' || value === 'owntone' || value === 'audiostation';
}
export function requireConnectionStrategy(value: unknown): ConnectionStrategy {
  if (!isConnectionStrategy(value)) {
    throw new Error('invalid AirPlay connection strategy');
  }
  return value;
}
