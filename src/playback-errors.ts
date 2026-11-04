/** Protocol-neutral start refusal; hats choose their wire status/envelope. */
export class PlaybackError extends Error {
  constructor(
    readonly code: 'no_target' | 'target_unavailable' | 'playback_cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'PlaybackError';
  }
}
