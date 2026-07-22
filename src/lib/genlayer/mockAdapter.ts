import type { CheckPayload, CheckStatus, CompatibilityResult, PendingTransaction, ProgressHandler, SpecMatchAdapter, Summary, Verdict } from "./types";
import { payloadIdentity } from "./contractAdapter";

const OWNER = "0x5pecMatch000000000000000000000000000001";
const store: CompatibilityResult[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function classify(payload: CheckPayload): Verdict {
  const implementation = payload.implementation.toLowerCase();
  if (/unknown|unclear|not documented|tbd/.test(implementation)) return "unclear";
  if (/does not|missing|removed|instead|throws always|never/.test(implementation)) return "breaking";
  return "compatible";
}

export class MockAdapter implements SpecMatchAdapter {
  readonly mode = "mock" as const;
  private connected = false;
  getIdentityAddress(): string | null { return this.connected ? OWNER : null; }
  hasInjectedWallet(): boolean { return true; }
  disconnectWallet(): void { this.connected = false; }
  getPending(): PendingTransaction | null { return null; }
  async connectWallet(onProgress?: ProgressHandler): Promise<string> {
    onProgress?.({ phase: "wallet", message: "Connecting demo identity" });
    await wait(180); this.connected = true; return OWNER;
  }
  async recoverPending(): Promise<CompatibilityResult | null> { return null; }

  async submitCheck(requestId: string, payload: CheckPayload, onProgress: ProgressHandler): Promise<CompatibilityResult> {
    onProgress({ phase: "validating", message: "Validating compatibility inputs" });
    if (!payload.specification.trim() || !payload.implementation.trim()) throw new Error("Specification and implementation behavior are required.");
    if (!this.connected) await this.connectWallet(onProgress);
    const previous = store.find((item) => item.request_id === requestId && item.sender === OWNER);
    if (previous) return previous;
    onProgress({ phase: "signing", message: "Signing demo transaction" }); await wait(220);
    const hash = `0x${Array.from({ length: 64 }, (_, index) => ((requestId.charCodeAt(index % requestId.length) + index) % 16).toString(16)).join("")}`;
    onProgress({ phase: "submitted", message: "Transaction submitted", hash }); await wait(250);
    onProgress({ phase: "consensus", message: "Independent validators are comparing behavior", hash }); await wait(600);
    const verdict = classify(payload);
    const status: CheckStatus = verdict === "compatible" ? "match" : verdict === "breaking" ? "mismatch" : "unclear";
    const names = ["inputs", "outputs", "errors", "side_effects", "constraints"];
    const checks = names.map((name) => ({ name, status, detail: `${name.replace("_", " ")} behavior is ${status}.`, evidence: [{ source: "specification" as const, excerpt: payload.specification.trim().slice(0, 120) }] }));
    const result: CompatibilityResult = {
      key: `${OWNER.toLowerCase()}:${requestId}`, request_id: requestId, sender: OWNER, verdict, confidence: verdict === "unclear" ? "low" : "high",
      matched_requirements: status === "match" ? checks.map((item) => ({ requirement: item.name, detail: item.detail })) : [],
      mismatches: status === "mismatch" ? checks.map((item) => ({ requirement: item.name, detail: item.detail })) : [],
      explanation: verdict === "compatible" ? "The supplied implementation aligns with the expected behavior across the stable compatibility dimensions." : verdict === "breaking" ? "The implementation description indicates material differences from the expected behavior." : "The implementation description does not provide enough detail for a reliable compatibility verdict.",
      evidence: checks[0].evidence, checks, payload_identity: payloadIdentity(payload), created_at: Date.now(), transaction_hash: hash,
    };
    store.unshift(result);
    onProgress({ phase: "accepted", message: "Transaction accepted", hash }); await wait(180);
    onProgress({ phase: "verifying", message: "Verifying canonical contract state", hash }); await wait(180);
    onProgress({ phase: "complete", message: "Canonical result verified", hash });
    return result;
  }
  async getResult(sender: string, requestId: string): Promise<CompatibilityResult | null> { return store.find((item) => item.sender.toLowerCase() === sender.toLowerCase() && item.request_id === requestId) ?? null; }
  async getResults(offset = 0, limit = 20): Promise<CompatibilityResult[]> { return store.slice(offset, offset + Math.min(limit, 20)); }
  async getSummary(): Promise<Summary> { return { total: store.length, compatible: store.filter((x) => x.verdict === "compatible").length, breaking: store.filter((x) => x.verdict === "breaking").length, unclear: store.filter((x) => x.verdict === "unclear").length }; }
}
