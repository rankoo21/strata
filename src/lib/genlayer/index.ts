import type { SpecMatchAdapter } from "./types";
import { ContractAdapter } from "./contractAdapter";
import { MockAdapter } from "./mockAdapter";

let cached: SpecMatchAdapter | null = null;

export function getAdapter(): SpecMatchAdapter {
  if (cached) return cached;
  const mode = process.env.NEXT_PUBLIC_SPECMATCH_MODE ?? "mock";
  const contractAddress = process.env.NEXT_PUBLIC_SPECMATCH_CONTRACT ?? "";
  cached = mode === "contract" && contractAddress
    ? new ContractAdapter({ contractAddress, network: process.env.NEXT_PUBLIC_SPECMATCH_NETWORK ?? "bradbury" })
    : new MockAdapter();
  return cached;
}

export * from "./types";
