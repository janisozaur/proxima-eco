/**
 * WebHID type declarations.
 *
 * `navigator.hid` is not part of the TypeScript DOM typings (WebHID is Chrome/Edge only), so the
 * API is declared here rather than cast to `unknown` at every call site. Shapes follow the WebHID
 * spec; nothing here is invented beyond what the spec defines.
 */

export interface HidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceNameAndVersion: string;
  readonly deviceInstanceHandle: number;
  readonly maxReportsCount: number;
  readonly maxMessageSize: number;

  send(reportId: number, data: Uint8Array): void;
  receive(): Promise<Uint8Array>;
  abort(): void;
  forEachReport(cb: (report: Uint8Array) => void): Promise<void>;
  getCollections(): Promise<HidCollection[]>;
  getDeviceInfo(): Promise<HidDeviceInfo>;
  close(): void;
}

export interface HidCollection {
  readonly usagePage: number;
  readonly collectionType: string;
  get(usagePage: number): HidDevice[];
}

export interface HidDeviceInfo {
  readonly deviceNameAndVersion: string;
  readonly deviceInstanceHandle: number;
  readonly productId: number;
  readonly vendorId: number;
  readonly maxReportsCount: number;
  readonly maxMessageSize: number;
  readonly collections: HidCollection[];
}

export interface HidApi {
  requestDevice(options: { filters: HidFilter[] }): Promise<HidDevice[]>;
  enumerateDevices?(): Promise<HidDevice[]>;
}

export interface HidFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  interface?: number; // 0 = no report ID, 1 = with report ID
}

/** `navigator.hid`, present only where WebHID is implemented. */
export interface NavigatorWithHid {
  readonly hid?: HidApi;
}
