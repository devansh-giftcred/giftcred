import bcrypt from "bcrypt";
import { AuthError } from "../lib/errors.js";

const BCRYPT_ROUNDS = 12;

const PASSWORD_COMPLEXITY =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;

export function validatePasswordComplexity(password: string): void {
  if (!PASSWORD_COMPLEXITY.test(password)) {
    throw new AuthError(
      "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.",
      400
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordComplexity(password);
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
