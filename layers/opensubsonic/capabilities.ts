// Hat-owned, server-wide protocol facts. Add a version only after its consumer
// contract is proved; neither callers nor user state can change this registry.
export interface Capability {
  readonly name: string;
  readonly versions: readonly number[];
}

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  Object.freeze({ name: 'formPost', versions: Object.freeze([1]) }),
  Object.freeze({ name: 'transcodeOffset', versions: Object.freeze([1]) }),
  Object.freeze({ name: 'transcoding', versions: Object.freeze([1]) }),
  Object.freeze({ name: 'songLyrics', versions: Object.freeze([1, 2]) }),
]);

// One semantic projection for JSON and the envelope's repeated-array XML.
// Fresh arrays keep response consumers from mutating the registry's facts.
export function capabilityPayload(
  capabilities: readonly Capability[] = CAPABILITIES,
): { openSubsonicExtensions: { name: string; versions: number[] }[] } {
  return {
    openSubsonicExtensions: capabilities.map(({ name, versions }) => ({
      name,
      versions: [...versions],
    })),
  };
}
