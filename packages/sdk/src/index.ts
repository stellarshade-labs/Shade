export { StealthClient } from './client.js';

export {
  keysFromWalletSignature,
  stealthKeysFromRaw,
  DEFAULT_KEY_SCOPE,
  DEFAULT_APP_ID,
  type WalletSigner,
  type WalletKeysOpts,
} from './wallet.js';

/**
 * Crypto's raw (Uint8Array-based) stealth keys, re-exported under a distinct
 * name so code that mixes both layers has one import site: convert with
 * {@link stealthKeysFromRaw} to get the SDK's hex-string {@link StealthKeys}.
 */
export type { StealthKeys as RawStealthKeys } from '@shade/crypto';

export {
  ShadeError,
  UnsupportedNetworkError,
  RelayerHttpError,
  RelayerNetworkError,
  NoHealthyRelayerError,
  IndexerHttpError,
  IndexerNetworkError,
  MethodRequiredError,
  MethodNotEnabledError,
  MethodNotAvailableError,
  MinimumAmountError,
  ClaimAmountError,
  ClaimAmountRequiresNoMergeError,
  InvalidAmountError,
  SponsoredClaimMismatchError,
  WrongPasswordError,
  SessionIntegrityError,
  NoBalanceError,
  AnnouncementNotFoundError,
  StealthAccountNotFoundError,
  DestinationTrustlineError,
  FeePayerRequiredError,
  FeePayerAddressRequiredError,
  EntryArchivedRestoringError,
  ContractIdRequiredError,
  TransactionRetryableError,
  TransactionTimeoutError,
} from './errors.js';

export {
  parseStroops,
  numberToStroops,
  formatStroops,
} from './stroops.js';

export {
  NETWORKS,
  getNetworkConfig,
  networkNameForPassphrase,
  labelForToken,
  resolveTokenAddress,
  createSimulationTx,
  simulateReadOnly,
  waitForTransaction,
  buildWithdrawMessage,
} from './soroban.js';
export type {
  NetworkName,
  NetworkDefinition,
  NetworkConfig,
  TransactionStatusSource,
} from './soroban.js';

export { HorizonClient } from './horizon.js';
export type {
  HorizonTx,
  HorizonOp,
  HorizonAccount,
  HorizonClaimant,
  HorizonPredicate,
  HorizonClaimableBalance,
  FetchLike,
} from './horizon.js';

export { RelayerClient, challengeMessage } from './relayer.js';
export type {
  RelayerHealth,
  RelayOpts,
  SponsorOpts,
  SponsorClaimPrepareArgs,
  SponsorClaimPrepared,
  CreditView,
  FundingSigner,
  CreditChallenge,
} from './relayer.js';

export { IndexerClient } from './indexer.js';
export type {
  IndexerHealth,
  IndexerAnnouncement,
  AnnouncementsPage,
} from './indexer.js';

export { RelayerPool, normalizeRelayList } from './relayerPool.js';
export type {
  RelayerSelection,
  RelayerPoolOpts,
  RelayerCallCtx,
  ProbeOutcome,
} from './relayerPool.js';

export { StealthSession } from './session.js';
export type { KVStorage, StealthSessionOpts, ScanState } from './session.js';

export { prepareWithRestore } from './methods/restore.js';
export type {
  RestoreSigner,
  RestoreSubmit,
  RestoreNotify,
  RebuildInvocation,
} from './methods/restore.js';

export type { DeliveryAdapter, AdapterSendParams } from './methods/types.js';
export { PoolAdapter } from './methods/pool.js';
export { AccountAdapter } from './methods/account.js';
export { SppAdapter } from './methods/spp.js';

export type {
  DeliveryMethod,
  StealthKeys,
  SendReceipt,
  SendOpts,
  Payment,
  Balance,
  WithdrawReceipt,
  WithdrawOpts,
  ClientConfig,
  ScanCursor,
  ScanOpts,
  ScanResult,
  ClaimOpts,
  ClaimReceipt,
  TransactionSigner,
} from './types.js';
