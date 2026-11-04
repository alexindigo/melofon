export class SpeakerError extends Error {
  override name = 'SpeakerError';
  constructor(
    public code:
      | 'not_found'
      | 'invalid_field'
      | 'unknown_field'
      | 'unsupported_protocol'
      | 'not_adopted'
      | 'already_adopted'
      | 'speaker_in_use'
      | 'speaker_busy'
      | 'persistence_failed',
    message: string,
  ) {
    super(message);
  }
}
