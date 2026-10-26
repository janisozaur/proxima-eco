/**
 * Browser capability detection. WebHID is Chrome/Edge only; the UI must say so rather than fail
 * cryptically.
 */

import type { NavigatorWithHid } from '../types/webhid.ts';

export function webHidAvailable(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithHid);
  return nav?.hid != null;
}
