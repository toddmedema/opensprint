import crypto from "crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LENGTH = 8;

/**
 * Generate a short feedback ID: 8 alphanumeric characters (a-z, 0-9).
 * Uses crypto.randomBytes for cryptographic randomness.
 * 36^8 ≈ 2.8 trillion possible values; collision probability is negligible.
 */
export function generateShortFeedbackId(): string {
  const bytes = crypto.randomBytes(LENGTH);
  let result = "";
  for (let i = 0; i < LENGTH; i++) {
    result += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return result;
}
