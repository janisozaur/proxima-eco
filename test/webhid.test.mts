/**
 * The device identity the browser reports, and how the app prints it. Only the formatting is tested
 * here: `describeDevices` needs `navigator.hid`, which no Node process has.
 */

import { ok } from 'node:assert';

function eq(actual: unknown, expected: unknown): void {
  ok(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
import { formatIdentity, filterLiteral } from '../src/webhid.ts';

// ---- a real-looking pair: the IDs a HID descriptor writes as four hex digits ----
{
  const d = {vendorId: 0x04d9, productId: 0x1201, maxMessageSize: 64, maxReportsCount: 1};
  eq(formatIdentity(d), 'VID 0x04D9 (1241) · PID 0x1201 (4609) · 64-byte reports');
  eq(filterLiteral(d), '{ vendorId: 0x04D9, productId: 0x1201 }');
}

// ---- the decimal is what the browser's own prompt shows, so both are printed ----
{
  const d = {vendorId: 0, productId: 0, maxMessageSize: 8, maxReportsCount: 0};
  eq(formatIdentity(d), 'VID 0x0000 (0) · PID 0x0000 (0) · 8-byte reports');
  eq(filterLiteral(d), '{ vendorId: 0x0000, productId: 0x0000 }');
}

// ---- an ID above 0xFFFF still prints as hex, it is only padded to a minimum ----
{
  const d = {vendorId: 0x123456, productId: 0xabcdef, maxMessageSize: 64, maxReportsCount: 8};
  eq(formatIdentity(d), 'VID 0x123456 (1193046) · PID 0xABCDEF (11259375) · 64-byte reports');
}
