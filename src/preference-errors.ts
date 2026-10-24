export class PreferenceError extends Error {
  constructor(
    readonly code:
      | 'invalid_value'
      | 'unknown_preference'
      | 'too_large'
      | 'revision_conflict',
    message: string,
    readonly key?: string,
    readonly revisions?: Record<string, number>,
  ) {
    super(message);
    this.name = 'PreferenceError';
  }
}
