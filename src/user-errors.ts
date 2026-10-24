export type UserErrorCode =
  | 'name_taken'
  | 'last_admin'
  | 'forbidden'
  | 'not_found'
  | 'password_too_short'
  | 'invalid_credentials';

export class UserError extends Error {
  constructor(public readonly code: UserErrorCode) {
    super(code === 'invalid_credentials' ? 'Wrong username or password' : code);
    this.name = 'UserError';
  }
}
