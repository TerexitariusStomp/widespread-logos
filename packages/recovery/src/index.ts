export { splitVaultKey, combineShares, newVaultKey, type ShareSet } from './shares'
export { deriveFromPrf, type PrfDerived } from './derive'
export {
  sealKit,
  openKit,
  wrapShare,
  unwrapShare,
  kitEncoding,
  type RecoveryKitContents,
} from './kit'
export { type StorageClient, RestStorageClient } from './storage'
export {
  enroll,
  recover,
  onboardVault,
  recoverVault,
  type EnrollResult,
  type OnboardResult,
  type PointerResolver,
} from './enroll'
export { sealBlob, openBlob } from './blob'
export {
  createPasskeyWithPrf,
  getPasskeyPrf,
  passkeyPrfSupported,
  type PasskeyResult,
} from './passkey'
