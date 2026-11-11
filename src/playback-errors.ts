/** Protocol-neutral start refusal; hats choose their wire status/envelope. */
export class PlaybackError extends Error {
  constructor(
    readonly code:
      | 'no_target'
      | 'target_unavailable'
      | 'airplay_busy'
      | 'playback_cancelled'
      | 'invalid_reference'
      | 'missing_reference'
      | 'queue_limit',
    message: string,
    readonly owner?: { id: number; name: string },
  ) {
    super(message);
    this.name = 'PlaybackError';
  }
}

export class QueueLimitError extends PlaybackError {
  constructor(readonly limit: number) {
    super('queue_limit', `Queue limit is ${limit} entries`);
  }
}
