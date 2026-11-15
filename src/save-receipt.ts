/** A synchronous publication has succeeded independently of its durable save. */
export interface PublishedCommandReceipt<T> {
  /** Preserve command timing: acknowledge after the first ordered save attempt,
   * even when storage failed and the household owner retained the batch. */
  readonly command: Promise<T>;
  /** Resolves only when that captured batch is saved (or durably obsoleted).
   * Retryable failures do not reject it; health/close report unsaved intent. */
  readonly saved: Promise<void>;
}

/** Admission precedes the synchronous callback. A refusal before publication
 * throws to the command caller; after publication only the save may be pending.
 * The household persistence owner retries the immutable batch, never change(). */
export interface PublishedCommandPort {
  publish<T>(change: () => T): PublishedCommandReceipt<T>;
}
