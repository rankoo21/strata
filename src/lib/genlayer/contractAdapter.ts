import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { localnet, studionet, testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import type { TransactionHash } from "genlayer-js/types";
import type { CheckPayload, CompatibilityResult, PendingTransaction, ProgressHandler, SpecMatchAdapter, Summary } from "./types";

type AnyClient = ReturnType<typeof createClient>;
type Receipt = Awaited<ReturnType<AnyClient["getTransaction"]>>;
const APP_ID = "SpecMatch";
const PENDING_KEY = "specmatch.pending.transaction.v1";
const RESULT_POLL_INTERVAL_MS = 3000;
const RESULT_POLL_ATTEMPTS = 30;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chainFor(network = "studionet") {
  const name = network.toLowerCase();
  if (name === "localnet") return localnet;
  if (name.includes("bradbury")) return testnetBradbury;
  return studionet;
}

function networkFor(network = "studionet"): "studionet" | "testnetBradbury" | "localnet" {
  const name = network.toLowerCase();
  if (name === "localnet") return "localnet";
  if (name.includes("bradbury")) return "testnetBradbury";
  return "studionet";
}

function plain(value: unknown): any {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [String(key), plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "bigint") return Number(value);
  return value;
}

function fingerprint(value: string): string {
  let hash = 1469598103934665603n;
  for (const char of value) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function payloadIdentity(payload: CheckPayload): string {
  const specification = payload.specification.trim();
  const implementation = payload.implementation.trim();
  const constraints = (payload.constraints ?? "").trim();
  const canonical = `${specification.length}:${specification}|${implementation.length}:${implementation}|${constraints.length}:${constraints}`;
  return `fnv1a64:${fingerprint(canonical)}:${specification.length}:${implementation.length}:${constraints.length}`;
}

function receiptFailure(receipt: Receipt): string | null {
  const status = String(receipt.statusName ?? receipt.status ?? "");
  if (["CANCELED", "UNDETERMINED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(status)) {
    return `Transaction reached ${status} instead of acceptance.`;
  }
  if (receipt.txExecutionResultName === "FINISHED_WITH_ERROR" || receipt.txExecutionResult === 2) {
    return "Contract execution finished with an error.";
  }
  const leaderReceipts = receipt.consensus_data?.leader_receipt ?? [];
  const failed = leaderReceipts.find((item) => item.execution_result === "FINISHED_WITH_ERROR" || Boolean(item.error));
  if (!failed) return null;
  const detail = failed.error || failed.result;
  return detail ? `Contract execution failed: ${String(detail).slice(0, 320)}` : "Contract execution finished with an error.";
}

export class ContractAdapter implements SpecMatchAdapter {
  readonly mode = "contract" as const;
  private readClient: AnyClient | null = null;
  private walletClient: AnyClient | null = null;
  private walletAddress: string | null = null;

  constructor(private config: { contractAddress: string; network?: string }) {}

  private get address(): `0x${string}` { return this.config.contractAddress as `0x${string}`; }
  private get chain() { return chainFor(this.config.network); }
  private reader(): AnyClient {
    if (!this.readClient) this.readClient = createClient({ chain: this.chain, account: createAccount(generatePrivateKey()) });
    return this.readClient;
  }
  private async read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return plain(await this.reader().readContract({ address: this.address, functionName, args: args as any })) as T;
  }
  hasInjectedWallet(): boolean { return typeof window !== "undefined" && Boolean((window as any).ethereum); }
  getIdentityAddress(): string | null { return this.walletAddress; }
  disconnectWallet(): void { this.walletClient = null; this.walletAddress = null; }

  async connectWallet(onProgress?: ProgressHandler): Promise<string> {
    onProgress?.({ phase: "wallet", message: "Requesting wallet access" });
    if (typeof window === "undefined" || !(window as any).ethereum) throw new Error("MetaMask with GenLayer Snap is required to submit checks.");
    const accounts: string[] = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
    const address = accounts?.[0];
    if (!address) throw new Error("The wallet returned no account.");
    const client = createClient({ chain: this.chain, account: address as `0x${string}` }) as AnyClient;
    await client.connect(networkFor(this.config.network));
    this.walletClient = client;
    this.walletAddress = address;
    return address;
  }

  getPending(): PendingTransaction | null {
    if (typeof window === "undefined") return null;
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
      if (!parsed || typeof parsed.hash !== "string" || typeof parsed.requestId !== "string" || typeof parsed.payloadIdentity !== "string") return null;
      const account = parsed.account ?? parsed.sender;
      const timestamp = parsed.timestamp ?? parsed.createdAt;
      if (typeof account !== "string" || typeof timestamp !== "number") return null;
      return { app: APP_ID, requestId: parsed.requestId, hash: parsed.hash, account, timestamp, payloadIdentity: parsed.payloadIdentity };
    } catch { return null; }
  }

  private explorer(hash: string): string {
    const base = this.config.network?.toLowerCase().includes("bradbury") ? "https://explorer-bradbury.genlayer.com" : "https://explorer.genlayer.com";
    return `${base}/tx/${hash}`;
  }

  private async pollCanonicalResult(pending: PendingTransaction): Promise<CompatibilityResult> {
    for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
      const result = await this.getResult(pending.account, pending.requestId);
      if (result) {
        if (result.sender.toLowerCase() !== pending.account.toLowerCase() || result.request_id !== pending.requestId || result.payload_identity !== pending.payloadIdentity) {
          throw new Error("Stored result identity does not match the pending SpecMatch request.");
        }
        return result;
      }
      if (attempt < RESULT_POLL_ATTEMPTS - 1) await sleep(RESULT_POLL_INTERVAL_MS);
    }
    throw new Error("The transaction was accepted but canonical state is not readable yet. Reload to continue from the saved transaction hash; SpecMatch will not submit another write.");
  }

  private async finish(pending: PendingTransaction, onProgress: ProgressHandler, recovering = false): Promise<CompatibilityResult> {
    const proof = this.explorer(pending.hash);
    onProgress({ phase: "consensus", message: "Waiting for validator consensus", hash: pending.hash, explorerUrl: proof, recovering });
    const receipt = await this.reader().waitForTransactionReceipt({ hash: pending.hash as unknown as TransactionHash, status: TransactionStatus.ACCEPTED, interval: 6000, retries: 150 });
    const fullReceipt = await this.reader().getTransaction({ hash: pending.hash as unknown as TransactionHash });
    const failure = receiptFailure(fullReceipt ?? receipt);
    if (failure) throw new Error(failure);
    onProgress({ phase: "accepted", message: "Transaction accepted without an execution error", hash: pending.hash, explorerUrl: proof, recovering });
    onProgress({ phase: "verifying", message: "Polling canonical contract state", hash: pending.hash, explorerUrl: proof, recovering });
    const result = await this.pollCanonicalResult(pending);
    if (typeof window !== "undefined") localStorage.removeItem(PENDING_KEY);
    const complete = { ...result, transaction_hash: pending.hash };
    onProgress({ phase: "complete", message: "Canonical result verified", hash: pending.hash, explorerUrl: proof, recovering });
    return complete;
  }

  async submitCheck(requestId: string, payload: CheckPayload, onProgress: ProgressHandler): Promise<CompatibilityResult> {
    onProgress({ phase: "validating", message: "Validating compatibility inputs" });
    if (!payload.specification.trim() || !payload.implementation.trim()) throw new Error("Specification and implementation behavior are required.");
    const existing = this.getPending();
    if (existing) return this.finish(existing, onProgress, true);
    if (!this.walletClient || !this.walletAddress) await this.connectWallet(onProgress);
    if (!this.walletClient || !this.walletAddress) throw new Error("Connect a wallet to submit this check.");
    onProgress({ phase: "signing", message: "Confirm the transaction in your wallet" });
    const timestamp = Date.now();
    const normalizedPayload = { specification: payload.specification.trim(), implementation: payload.implementation.trim(), constraints: (payload.constraints ?? "").trim() };
    // Exactly one write occurs. Hash recovery and all later retries only read receipt and contract state.
    const hash = await this.walletClient.writeContract({
      address: this.address,
      functionName: "submit_check",
      args: [requestId, JSON.stringify(normalizedPayload), timestamp] as any,
      value: 0n,
    });
    const pending: PendingTransaction = { app: APP_ID, requestId, hash: String(hash), account: this.walletAddress, timestamp, payloadIdentity: payloadIdentity(normalizedPayload) };
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    onProgress({ phase: "submitted", message: "Transaction hash saved for same-hash recovery", hash: pending.hash, explorerUrl: this.explorer(pending.hash) });
    return this.finish(pending, onProgress);
  }

  async recoverPending(onProgress: ProgressHandler): Promise<CompatibilityResult | null> {
    const pending = this.getPending();
    if (!pending) return null;
    return this.finish(pending, onProgress, true);
  }

  async getResult(sender: string, requestId: string): Promise<CompatibilityResult | null> { return (await this.read<CompatibilityResult | null>("get_result", [sender, requestId])) ?? null; }
  async getResults(offset = 0, limit = 20): Promise<CompatibilityResult[]> { return (await this.read<CompatibilityResult[]>("get_results", [offset, limit])) ?? []; }
  async getSummary(): Promise<Summary> { return this.read<Summary>("get_summary"); }
}
