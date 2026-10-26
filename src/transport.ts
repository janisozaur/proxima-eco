/**
 * Transport abstraction.
 *
 * The gate is strictly request → response with no pipelining, so a transport only has to send one
 * report and hand back the matching reply. Unsolicited `0x90` pushes may arrive between exchanges;
 * transports route them to registered handlers rather than returning them as replies.
 */

import type { Frame } from './protocol.ts';

export interface PushHandler {
  handle(frame: Frame): void;
}

export interface Transport {
  /** Send one report and await its response frame. */
  request(opcode: number, body?: Uint8Array): Promise<Frame>;
  /** Register a handler for unsolicited pushes. */
  onPush(handler: PushHandler): void;
  close(): void;
}
