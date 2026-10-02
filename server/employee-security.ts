import {
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);

const PIN_PATTERN = /^\d{4,6}$/;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export function validEmployeePin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

export async function hashEmployeePin(pin: string) {
  if (!validEmployeePin(pin)) {
    throw new Error("Invalid employee PIN.");
  }

  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(pin, salt, HASH_BYTES)) as Buffer;

  return {
    hash: derived.toString("base64"),
    salt: salt.toString("base64"),
  };
}

export async function verifyEmployeePin(
  pin: string,
  storedHash: string,
  storedSalt: string,
) {
  if (!validEmployeePin(pin)) return false;

  try {
    const expected = Buffer.from(storedHash, "base64");
    const salt = Buffer.from(storedSalt, "base64");

    if (expected.length !== HASH_BYTES || salt.length !== SALT_BYTES) {
      return false;
    }

    const actual = (await scrypt(pin, salt, expected.length)) as Buffer;

    return (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
