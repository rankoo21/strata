"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { getAdapter, type CompatibilityResult, type Summary, type TransactionPhase, type TransactionUpdate } from "@/lib/genlayer";

const PHASES: { id: TransactionPhase; label: string }[] = [
  { id: "validating", label: "Validate" }, { id: "wallet", label: "Wallet" },
  { id: "signing", label: "Sign" }, { id: "submitted", label: "Submit" },
  { id: "consensus", label: "Consensus" }, { id: "accepted", label: "Accepted" },
  { id: "verifying", label: "Verify" }, { id: "complete", label: "Complete" },
];

const EMPTY_SUMMARY: Summary = { total: 0, compatible: 0, breaking: 0, unclear: 0 };
const short = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

export default function Page() {
  const adapter = useMemo(() => getAdapter(), []);
  const [specification, setSpecification] = useState("The endpoint accepts a string and returns a normalized string. Invalid input returns E_INPUT without side effects.");
  const [implementation, setImplementation] = useState("The endpoint accepts a string and returns a normalized string. Invalid input returns E_INPUT without side effects.");
  const [constraints, setConstraints] = useState("");
  const [identity, setIdentity] = useState<string | null>(null);
  const [update, setUpdate] = useState<TransactionUpdate>({ phase: "idle", message: "Ready for a new compatibility check" });
  const [result, setResult] = useState<CompatibilityResult | null>(null);
  const [recent, setRecent] = useState<CompatibilityResult[]>([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [error, setError] = useState<string | null>(null);
  const busy = !["idle", "complete", "error"].includes(update.phase);

  const refresh = async () => {
    try { const [items, totals] = await Promise.all([adapter.getResults(0, 8), adapter.getSummary()]); setRecent(items); setSummary(totals); }
    catch { /* Public reads can be unavailable while a network initializes. */ }
  };

  useEffect(() => {
    setIdentity(adapter.getIdentityAddress());
    refresh();
    if (adapter.getPending()) {
      adapter.recoverPending(setUpdate).then((recovered) => { if (recovered) setResult(recovered); return refresh(); })
        .catch((reason) => { setError(String(reason?.message ?? reason)); setUpdate((current) => ({ ...current, phase: "error", recovering: true })); });
    }
  }, [adapter]);

  async function connect() {
    setError(null);
    try { setIdentity(await adapter.connectWallet(setUpdate)); setUpdate({ phase: "idle", message: "Wallet connected" }); }
    catch (reason: any) { setError(reason?.message ?? "Wallet connection failed."); setUpdate({ phase: "error", message: "Wallet connection failed" }); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null); setResult(null);
    const requestId = `check-${Date.now().toString(36)}`;
    try {
      const next = await adapter.submitCheck(requestId, { specification, implementation, constraints }, setUpdate);
      setResult(next); setIdentity(adapter.getIdentityAddress()); await refresh();
    } catch (reason: any) {
      setError(reason?.message ?? "The consensus check failed.");
      setUpdate((current) => ({ ...current, phase: "error", message: "Check interrupted" }));
    }
  }


  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="SpecMatch home"><span className="brand-mark">S</span><span>SpecMatch</span></a>
      <div className="top-actions"><span className="mode">{adapter.mode} mode</span><button className="button secondary" type="button" onClick={connect}>{identity ? short(identity) : "Connect wallet"}</button></div>
    </header>

    <section className="hero" id="top">
      <div><p className="eyebrow">GENLAYER COMPATIBILITY CONSENSUS</p><h1>Compare behavior.<br /><span>Persist the verdict.</span></h1></div>
      <p className="hero-copy">SpecMatch asks independent validators to compare an expected interface against its implementation, then stores one canonical, evidence-grounded compatibility result.</p>
    </section>

    <section className="stats" aria-label="Result summary">
      <div><strong>{summary.total}</strong><span>Total checks</span></div><div><strong>{summary.compatible}</strong><span>Compatible</span></div><div><strong>{summary.breaking}</strong><span>Breaking</span></div><div><strong>{summary.unclear}</strong><span>Unclear</span></div>
    </section>

    <form className="workbench" onSubmit={submit}>
      <div className="section-heading"><div><p className="index">01 / INPUT</p><h2>Behavior contract</h2></div><p>Describe observable behavior. Concrete inputs, outputs, errors, and side effects produce stronger consensus.</p></div>
      <div className="input-grid">
        <label><span>Specification / expected behavior <b>Required</b></span><small>What callers rely on</small><textarea value={specification} onChange={(event) => setSpecification(event.target.value)} maxLength={6000} required /></label>
        <label><span>Implementation behavior <b>Required</b></span><small>What the implementation actually does</small><textarea value={implementation} onChange={(event) => setImplementation(event.target.value)} maxLength={6000} required /></label>
      </div>
      <label className="constraints"><span>Compatibility constraints <i>Optional</i></span><small>Versioning guarantees, protocol rules, or tolerated differences</small><textarea value={constraints} onChange={(event) => setConstraints(event.target.value)} maxLength={2500} placeholder="Example: additive response fields are allowed; status codes must remain stable." /></label>
      <div className="submit-row"><div><span className="status-dot" />Leader analysis + independent comparative validation</div><button className="button primary" disabled={busy} type="submit">{busy ? "Consensus in progress" : "Run consensus check"}<span aria-hidden>→</span></button></div>
    </form>

    <section className="progress-panel" aria-live="polite">
      <div className="section-heading compact"><div><p className="index">02 / TRANSACTION</p><h2>Consensus progress</h2></div><p>{update.message}</p></div>
      <div className="phase-strip">{PHASES.map((phase, index) => { const active = PHASES.findIndex((item) => item.id === update.phase); return <div key={phase.id} className={index < active || update.phase === "complete" ? "done" : index === active ? "active" : ""}><span>{String(index + 1).padStart(2, "0")}</span><b>{phase.label}</b></div>; })}</div>
      {update.hash && <div className="tx-hash"><span>Transaction</span><code>{short(update.hash)}</code>{update.explorerUrl && <a href={update.explorerUrl} target="_blank" rel="noreferrer">View in explorer</a>}</div>}
      {error && <div className="error" role="alert"><strong>{update.recovering ? "Recovery paused" : "Check interrupted"}</strong><span>{error}</span></div>}
    </section>

    {result && (
      <section className="result" aria-label="Canonical compatibility result">
        <div className="section-heading"><div><p className="index">03 / RESULT</p><h2>Canonical verdict</h2></div><p>Stored on chain and grounded in excerpts from your submitted text.</p></div>
        <div className="verdict-head">
          <span className={`verdict verdict-${result.verdict}`}>{result.verdict}</span>
          <span className="confidence">Confidence: {result.confidence}</span>
          {result.transaction_hash && <code className="verdict-hash">{short(result.transaction_hash)}</code>}
        </div>
        <p className="explanation">{result.explanation}</p>
        <div className="checks">
          {result.checks.map((check) => (
            <article key={check.name} className={`check check-${check.status}`}>
              <header><h3>{check.name}</h3><span className={`tag tag-${check.status}`}>{check.status}</span></header>
              <p>{check.detail}</p>
              {check.evidence.length > 0 && (
                <ul className="evidence">{check.evidence.map((item, index) => (
                  <li key={index}><span className="evidence-source">{item.source}</span><q>{item.excerpt}</q></li>
                ))}</ul>
              )}
            </article>
          ))}
        </div>
      </section>
    )}

    <section className="recent" aria-label="Recent checks">
      <div className="section-heading compact"><div><p className="index">04 / HISTORY</p><h2>Recent checks</h2></div><p>Latest canonical results across all submitters.</p></div>
      {recent.length === 0 ? (
        <p className="empty">No checks recorded yet. Run the first compatibility check above.</p>
      ) : (
        <ul className="recent-list">
          {recent.map((item) => (
            <li key={item.key}>
              <span className={`dot verdict-${item.verdict}`} aria-hidden />
              <span className={`verdict-mini verdict-${item.verdict}`}>{item.verdict}</span>
              <code>{item.request_id}</code>
              <span className="recent-sender">{short(item.sender)}</span>
              <span className="recent-confidence">{item.confidence}</span>
            </li>
          ))}
        </ul>
      )}
    </section>

    <footer className="footer">
      <span>SpecMatch</span>
      <span>API compatibility consensus on GenLayer</span>
    </footer>
  </main>;
}