// One canonical library-relative folder address language for requests and
// indexed directory ancestry. Keep this pattern compatible with JS and RE2;
// the store embeds it in SQL so eligibility is applied before count and LIMIT.
// The empty string is the configured root, handled separately by both callers.
export const invalidFolderPathPattern = String
  .raw`[\\\x00-\x1f\x7f]|^[a-zA-Z]:|(^|/)([.]{1,2})?(/|$)`;

const invalidFolderPath = new RegExp(invalidFolderPathPattern);

export function isFolderPath(path: unknown): path is string {
  return typeof path === 'string' &&
    (path === '' || !invalidFolderPath.test(path));
}
