"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useColumnStore } from "@/store/useColumnStore";

// The Core Tag: a small metal sample tag on a wire, the wallet object. It is
// the only identity path. Before connection it is blank and swings slightly,
// reading "Tag your core." Clicking it connects a browser wallet (MetaMask plus
// the GenLayer Snap). After connection it is stamped with a shortened address
// shown on hover. Never a rectangular connect button.
export function CoreTag() {
  const tagAddress = useColumnStore((s) => s.tagAddress);
  const tagLabel = useColumnStore((s) => s.tagLabel);
  const tagCore = useColumnStore((s) => s.tagCore);
  const releaseTag = useColumnStore((s) => s.releaseTag);
  const [hover, setHover] = useState(false);

  const tagged = Boolean(tagAddress);

  return (
    <div className="fixed top-4 right-4 z-40 flex flex-col items-center">
      {/* Wire */}
      <div className="w-[1px] h-6" style={{ background: "rgba(140,138,130,0.6)" }} />
      <motion.button
        onClick={() => (tagged ? releaseTag() : tagCore())}
        onHoverStart={() => setHover(true)}
        onHoverEnd={() => setHover(false)}
        animate={
          tagged
            ? { rotate: 0 }
            : { rotate: [-3, 3, -3] }
        }
        transition={
          tagged
            ? { duration: 0.4 }
            : { duration: 4, repeat: Infinity, ease: "easeInOut" }
        }
        style={{ transformOrigin: "top center" }}
        aria-label={tagged ? `Core tagged ${tagLabel}. Click to release.` : "Tag your core (connect a wallet)"}
        className="relative"
      >
        <div
          className="px-4 py-3 rounded-sm relative"
          style={{
            background: tagged
              ? "linear-gradient(180deg, #CDB089, #8a6a3a)"
              : "linear-gradient(180deg, #3a372f, #211f1a)",
            border: "1px solid rgba(11,10,8,0.6)",
            boxShadow: "0 2px 6px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.15)",
          }}
        >
          {/* Punch hole */}
          <div
            className="absolute -top-[5px] left-1/2 -translate-x-1/2 w-2 h-2 rounded-full"
            style={{ background: "#0B0A08", boxShadow: "inset 0 1px 1px rgba(0,0,0,0.8)" }}
          />
          <span
            className="font-mark text-[10px] tracking-[0.16em] uppercase"
            style={{ color: tagged ? "#1a1712" : "#8C8A82" }}
          >
            {tagged ? (hover ? `${tagLabel} · release` : "Core tagged") : "Connect wallet"}
          </span>
        </div>
      </motion.button>
      {!tagged && (
        <p
          className="mt-2 max-w-[13rem] text-right font-mark text-[10px] leading-relaxed"
          style={{ color: "rgba(140,138,130,0.6)", letterSpacing: "0.04em" }}
        >
          Connect a Bradbury-funded wallet to add and settle testimony. Viewing needs no wallet.
        </p>
      )}
    </div>
  );
}
