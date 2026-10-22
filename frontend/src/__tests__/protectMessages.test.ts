import { describe, expect, it } from 'vitest';
import { NativeCoreError } from '../api/nativeCore';
import { protectErrorMessage } from '../features/protect/messages';

const err = (code: ConstructorParameters<typeof NativeCoreError>[0], message: string) => new NativeCoreError(code, message);

describe('protect messages', () => {
  it('explains each failure in plain words', () => {
    expect(protectErrorMessage(err('password_required', 'x'))).toBe('Incorrect password. Please provide the correct user password.');
    expect(protectErrorMessage(err('invalid_input', 'invalid input: This PDF is already encrypted. Remove the existing password first.')))
      .toBe('This PDF is already encrypted. Remove the existing password first.');
    expect(protectErrorMessage(err('invalid_input', 'invalid input: This PDF is not encrypted - no password to remove.')))
      .toBe('This PDF is not encrypted - no password to remove.');
    expect(protectErrorMessage(err('invalid_input', 'invalid input: The user password is too long (at most 127 bytes).')))
      .toBe('The password is too long. Use at most 127 bytes (about 127 letters).');
    expect(protectErrorMessage(err('invalid_input', 'invalid input: Cannot open PDF: broken')))
      .toBe('This file does not look like a valid PDF.');
    expect(protectErrorMessage(err('not_found', 'x'))).toBe('The file could not be found. It may have been moved or renamed.');
    expect(protectErrorMessage(err('internal', 'boom'))).toBe('boom');
    expect(protectErrorMessage(new Error('plain'))).toBe('plain');
  });
});
