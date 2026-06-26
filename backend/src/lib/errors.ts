export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export class ConcurrencyError extends Error {
  constructor(message = "Concurrent modification detected. Please retry.") {
    super(message);
    this.name = "ConcurrencyError";
  }
}
