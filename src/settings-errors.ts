export class SettingsError extends Error {
  override name = 'SettingsError';
  constructor(
    readonly code: 'unknown_setting' | 'invalid_value' | 'revision_conflict',
    message: string,
    readonly key?: string,
    readonly revisions?: Record<string, number>,
  ) {
    super(message);
  }
}
