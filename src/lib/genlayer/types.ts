export type Verdict = "compatible" | "breaking" | "unclear";
export type Confidence = "low" | "medium" | "high";
export type CheckStatus = "match" | "mismatch" | "unclear";
export type EvidenceSource = "specification" | "implementation" | "constraints";

export interface CheckPayload {
  specification: string;
  implementation: string;
  constraints?: string;
}

export interface ResultDetail {
  requirement: string;
  detail: string;
}

export interface EvidenceExcerpt {
  source: EvidenceSource;
  excerpt: string;
}

export interface CompatibilityCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  evidence: EvidenceExcerpt[];
}

export interface CompatibilityResult {
  key: string;
  request_id: string;
  sender: string;
  verdict: Verdict;
  confidence: Confidence;
  matched_requirements: ResultDetail[];
  mismatches: ResultDetail[];
  explanation: string;
  evidence: EvidenceExcerpt[];
  checks: CompatibilityCheck[];
  payload_identity: string;
  created_at: number;
  transaction_hash?: string;
}

export interface Summary {
  total: number;
  compatible: number;
  breaking: number;
  unclear: number;
}

export type TransactionPhase =
  | "idle"
  | "validating"
  | "wallet"
  | "signing"
  | "submitted"
  | "consensus"
  | "accepted"
  | "verifying"
  | "complete"
  | "error";

export interface TransactionUpdate {
  phase: TransactionPhase;
  message: string;
  hash?: string;
  explorerUrl?: string;
  recovering?: boolean;
}

export interface PendingTransaction {
  app: "SpecMatch";
  requestId: string;
  hash: string;
  account: string;
  timestamp: number;
  payloadIdentity: string;
}

export type ProgressHandler = (update: TransactionUpdate) => void;

export interface SpecMatchAdapter {
  readonly mode: "mock" | "contract";
  getIdentityAddress(): string | null;
  hasInjectedWallet(): boolean;
  connectWallet(onProgress?: ProgressHandler): Promise<string>;
  disconnectWallet(): void;
  submitCheck(requestId: string, payload: CheckPayload, onProgress: ProgressHandler): Promise<CompatibilityResult>;
  recoverPending(onProgress: ProgressHandler): Promise<CompatibilityResult | null>;
  getResult(sender: string, requestId: string): Promise<CompatibilityResult | null>;
  getResults(offset?: number, limit?: number): Promise<CompatibilityResult[]>;
  getSummary(): Promise<Summary>;
  getPending(): PendingTransaction | null;
}
