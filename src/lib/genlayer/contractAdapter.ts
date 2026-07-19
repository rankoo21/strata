import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet, testnetBradbury, localnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import type {
  AddTestimonyInput,
  ArchivedCore,
  Column,
  Fault,
  Layer,
  LayerReading,
  ReadingResult,
  StrataAdapter,
  TestimonyResult,
} from "./types";

// Real GenLayer adapter. Implements the exact same StrataAdapter interface as
// the mock, so swapping it in does not touch a single line of UI code.
//
// To go live:
//   1. Deploy contracts/StrataContract.py (see scripts/deploy.mjs).
//   2. Set NEXT_PUBLIC_STRATA_MODE=contract and NEXT_PUBLIC_STRATA_CONTRACT=0x...
//   3. Optionally set NEXT_PUBLIC_STRATA_NETWORK (studionet | bradbury | localnet).
//
// Identity model: there is no in-browser burner key. Reads run against an
// account-less read-only client so anyone can view the strata without a wallet.
// Every write requires a real browser wallet (MetaMask plus the GenLayer Snap),
// connected through The Core Tag. No secret is ever bundled or generated here.

type AnyClient = ReturnType<typeof createClient>;

const ACCEPTED = TransactionStatus.ACCEPTED;
const IDENTITY_PREF_STORAGE = "strata.identity.mode";

// The geological voice used when a write is attempted without a tagged core.
const NEED_WALLET_MESSAGE = "Tag your core (connect a wallet) to do this.";

export interface ContractAdapterConfig {
  contractAddress: string;
  network?: string;
}

function pickChain(network?: string) {
  switch ((network ?? "studionet").toLowerCase()) {
    case "bradbury":
    case "testnet-bradbury":
    case "testnetbradbury":
      return testnetBradbury;
    case "localnet":
      return localnet;
    case "studionet":
    default:
      return studionet;
  }
}

function networkName(network?: string): "studionet" | "testnetBradbury" | "localnet" {
  switch ((network ?? "studionet").toLowerCase()) {
    case "bradbury":
    case "testnet-bradbury":
    case "testnetbradbury":
      return "testnetBradbury";
    case "localnet":
      return "localnet";
    default:
      return "studionet";
  }
}

// Recursively turn Maps (genlayer calldata) into plain objects so the UI can
// read fields with dot access regardless of how the value was decoded.
function toPlain(value: unknown): any {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) obj[String(k)] = toPlain(v);
    return obj;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === "bigint") return Number(value);
  return value;
}

export class ContractAdapter implements StrataAdapter {
  readonly mode = "contract" as const;
  private readonly config: ContractAdapterConfig;
  private readonly chain: ReturnType<typeof pickChain>;
  // Account-attached ephemeral client used for reads. It works without a wallet.
  private readClient: AnyClient | null = null;
  // Wallet-backed client, only present after a successful connectWallet().
  private walletClient: AnyClient | null = null;
  private walletAddress: string | null = null;
  private usingWallet = false;

  constructor(config: ContractAdapterConfig) {
    this.config = config;
    this.chain = pickChain(config.network);
  }

  // -- identity (the core tag) ----------------------------------------

  // Read-only client: created with a chain and an ephemeral throwaway account.
  // The account is never funded and never used for writes; it exists only so
  // genlayer-js has an account context and view calls never throw
  // "No account set". Anyone can read the strata with this, wallet or not.
  private getReadClient(): AnyClient {
    if (this.readClient) return this.readClient;
    const account = createAccount(generatePrivateKey());
    this.readClient = createClient({ chain: this.chain, account });
    return this.readClient;
  }

  hasInjectedWallet(): boolean {
    return typeof window !== "undefined" && Boolean((window as any).ethereum);
  }

  async connectWallet(): Promise<string> {
    if (typeof window === "undefined") throw new Error("Wallet connect is only available in the browser.");
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No browser wallet found. Install MetaMask with the GenLayer Snap to connect.");
    // Let client.connect() drive the handshake: it installs/activates the
    // GenLayer Snap and pops MetaMask for account selection. Calling
    // eth_requestAccounts first raced the Snap flow and could stop the wallet
    // prompt from appearing at all.
    const client = createClient({ chain: this.chain, provider: eth }) as AnyClient;
    let addr: string | undefined;
    try {
      await client.connect(networkName(this.config.network));
      const addresses = await client.getAddresses().catch(() => [] as string[]);
      addr = addresses?.[0];
    } catch (e: any) {
      if (e?.code === 4001) throw new Error("Wallet connection was rejected.");
      throw new Error(
        "Could not activate the GenLayer Snap in MetaMask. Approve the connection and Snap install, then try again.",
      );
    }
    if (!addr) {
      try {
        const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
        addr = accounts?.[0];
      } catch (e: any) {
        if (e?.code === 4001) throw new Error("Wallet connection was rejected.");
      }
    }
    if (!addr) throw new Error("Wallet connected but no account was returned.");
    this.walletClient = client;
    this.walletAddress = addr;
    this.usingWallet = true;
    window.localStorage.setItem(IDENTITY_PREF_STORAGE, "wallet");
    return addr;
  }

  disconnectWallet(): void {
    this.walletClient = null;
    this.walletAddress = null;
    this.usingWallet = false;
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(IDENTITY_PREF_STORAGE);
    }
  }

  isUsingWallet(): boolean {
    return this.usingWallet && Boolean(this.walletClient) && Boolean(this.walletAddress);
  }

  get ownerAddress(): string | null {
    // No burner fallback: identity exists only when a wallet is connected.
    return this.isUsingWallet() ? this.walletAddress : null;
  }

  getIdentityAddress(): string | null {
    return this.ownerAddress;
  }

  private get address(): `0x${string}` {
    return this.config.contractAddress as `0x${string}`;
  }

  // -- low level -------------------------------------------------------

  private async read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    const client = this.getReadClient();
    const raw = await client.readContract({
      address: this.address,
      functionName,
      args: args as any,
    });
    return toPlain(raw) as T;
  }

  // Translate raw RPC/consensus errors into plain, actionable guidance.
  private explainWriteError(e: unknown): Error {
    const msg = String((e as any)?.message ?? e);
    if (/enough funds|insufficient|cover transaction fees/i.test(msg)) {
      return new Error(
        "This wallet has no Bradbury funds. Claim test GEN from the Bradbury faucet, then try again.",
      );
    }
    if (/user rejected|4001/i.test(msg)) {
      return new Error("The transaction was rejected in your wallet.");
    }
    return e instanceof Error ? e : new Error(msg);
  }

  private async writeAndWait(functionName: string, args: unknown[]): Promise<any> {
    // Writes require a tagged core (a connected wallet). No burner fallback.
    if (!this.isUsingWallet() || !this.walletClient) {
      throw new Error(NEED_WALLET_MESSAGE);
    }
    const client = this.walletClient;
    try {
      const hash = await client.writeContract({
        address: this.address,
        functionName,
        args: args as any,
        value: 0n,
      });
      const receipt = await client.waitForTransactionReceipt({
        hash,
        status: ACCEPTED,
        interval: 6000,
        retries: 150,
      });
      return receipt;
    } catch (e) {
      throw this.explainWriteError(e);
    }
  }

  private extractReturn<T>(receipt: any): T | undefined {
    if (!receipt) return undefined;
    const candidates = [
      receipt?.consensus_data?.leader_receipt?.[0]?.result,
      receipt?.consensus_data?.leader_receipt?.result,
      receipt?.result,
      receipt?.returnValue,
      receipt?.data,
    ];
    for (const c of candidates) {
      if (c !== undefined && c !== null) return toPlain(c) as T;
    }
    return undefined;
  }

  // -- writes ----------------------------------------------------------

  async openColumn(subject: string): Promise<Column> {
    const receipt = await this.writeAndWait("open_column", [subject, Date.now()]);
    const columnId = this.extractReturn<string>(receipt);
    if (columnId) {
      const column = await this.getColumn(columnId);
      if (column) return column;
    }
    const columns = await this.getColumns();
    const mine = columns.find((c) => c.owner === this.ownerAddress);
    if (!mine) throw new Error("The column was opened but could not be read back.");
    return mine;
  }

  async addTestimony(input: AddTestimonyInput): Promise<TestimonyResult> {
    const receipt = await this.writeAndWait("add_testimony", [
      input.columnId,
      input.text,
      input.vantage,
      Date.now(),
    ]);
    const out = toPlain(this.extractReturn<any>(receipt)) ?? {};
    return {
      columnId: input.columnId,
      relation: (out.relation ?? "new") as TestimonyResult["relation"],
      testimonyId: out.testimonyId ?? "",
      layerId: out.layerId ?? "",
      faultId: out.faultId ?? null,
      state: (out.state ?? "") as TestimonyResult["state"],
      note: out.note ?? "",
    };
  }

  async takeReading(columnId: string): Promise<ReadingResult> {
    const receipt = await this.writeAndWait("take_reading", [columnId, Date.now()]);
    const out = toPlain(this.extractReturn<any>(receipt)) ?? {};
    return {
      columnId,
      layers: Number(out.layers ?? 0),
      hardened: Number(out.hardened ?? 0),
      corroborated: Number(out.corroborated ?? 0),
      floating: Number(out.floating ?? 0),
      faulted: Number(out.faulted ?? 0),
      note: out.note ?? "A deep reading settled the column.",
    };
  }

  async archiveCore(columnId: string): Promise<ArchivedCore> {
    const receipt = await this.writeAndWait("archive_core", [columnId, "", Date.now()]);
    const coreId = this.extractReturn<string>(receipt);
    const cores = await this.getCores(columnId);
    const found = cores.find((c) => c.id === coreId) ?? cores[0];
    if (!found) throw new Error("The core was archived but could not be read back.");
    return found;
  }

  // -- reads -----------------------------------------------------------

  async getColumns(): Promise<Column[]> {
    const all: Column[] = [];
    const limit = 20;
    let offset = 0;
    for (;;) {
      const page = await this.read<Column[]>("get_columns", [offset, limit]);
      if (!page || page.length === 0) break;
      all.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async getColumn(columnId: string): Promise<Column | null> {
    return (await this.read<Column | null>("get_column", [columnId])) ?? null;
  }

  async getLayers(columnId: string): Promise<Layer[]> {
    const all: Layer[] = [];
    const limit = 20;
    let offset = 0;
    for (;;) {
      const page = await this.read<Layer[]>("get_layers", [columnId, offset, limit]);
      if (!page || page.length === 0) break;
      all.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async getLayer(layerId: string): Promise<LayerReading | null> {
    return (await this.read<LayerReading | null>("get_layer", [layerId])) ?? null;
  }

  async getFaults(columnId: string): Promise<Fault[]> {
    const all: Fault[] = [];
    const limit = 20;
    let offset = 0;
    for (;;) {
      const page = await this.read<Fault[]>("get_faults", [columnId, offset, limit]);
      if (!page || page.length === 0) break;
      all.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async getCores(columnId?: string): Promise<ArchivedCore[]> {
    const all: ArchivedCore[] = [];
    const limit = 20;
    let offset = 0;
    const cid = columnId ?? "";
    for (;;) {
      const page = await this.read<ArchivedCore[]>("get_cores", [cid, offset, limit]);
      if (!page || page.length === 0) break;
      all.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }
    return all;
  }
}
