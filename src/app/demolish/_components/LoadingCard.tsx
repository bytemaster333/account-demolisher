"use client";

import { useEffect, useState } from "react";

// playful, meaningless-but-fun status quips that cycle under the real message
const LOADING_QUIPS = [
  "Prying open trustlines…",
  "Counting the stardust…",
  "Shaking loose the reserves…",
  "Poking sleepy DeFi positions…",
  "Herding claimable balances…",
  "Sweeping up dust tokens…",
  "Reticulating splines…",
  "Negotiating with the ledger…",
  "Untangling the multisig…",
  "Dusting off forgotten offers…",
  "Warming up the wrecking ball…",
  "Checking under the floorboards…",
];

// a thin (2px) concentric ring stroke: a conic-gradient with one bright accent
// sweep fading to transparent, cut to a ring by a radial mask, rotating slowly.
const RING_MASK =
  "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px))";
function ArcRing({
  inset,
  sweepDeg,
  dim,
  duration,
  reverse = false,
}: {
  readonly inset: number;
  readonly sweepDeg: number;
  readonly dim: number;
  readonly duration: number;
  readonly reverse?: boolean;
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        inset,
        borderRadius: "50%",
        background: `conic-gradient(from 0deg, color-mix(in srgb, var(--accent) ${dim}%, transparent), transparent ${sweepDeg}deg, transparent 360deg)`,
        maskImage: RING_MASK,
        WebkitMaskImage: RING_MASK,
        animation: `spin ${duration}s linear infinite${reverse ? " reverse" : ""}`,
      }}
    />
  );
}

// one glowing dot placed on an orbit of the given radius at a given angle. The
// lead dot is full accent with a glow; the rest are dimmer accent mixes.
function OrbitDot({
  angle,
  radius,
  size,
  lead = false,
  dim = 100,
}: {
  readonly angle: number;
  readonly radius: number;
  readonly size: number;
  readonly lead?: boolean;
  readonly dim?: number;
}): React.JSX.Element {
  return (
    <span
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: size,
        height: size,
        borderRadius: "50%",
        transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${radius}px)`,
        background: lead
          ? "var(--accent)"
          : `color-mix(in srgb, var(--accent) ${dim}%, transparent)`,
        ...(lead
          ? { boxShadow: "0 0 8px 1px color-mix(in srgb, var(--accent) 70%, transparent)" }
          : {}),
      }}
    />
  );
}

export function LeftLoadingCard({ message }: { readonly message: string }): React.JSX.Element {
  // cycle the fun sub-line; setState lives in the interval callback (async), so
  // it never runs synchronously in the effect body
  const [quipIdx, setQuipIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQuipIdx((i) => (i + 1) % LOADING_QUIPS.length), 1700);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: "transparent",
        border: "none",
        padding: "60px 28px",
        minHeight: 420,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 30,
        position: "relative",
      }}
    >
      {/* proving stage: a breathing glow, two counter-rotating ring strokes, two
          counter-rotating particle orbits, and a breathing diamond core with a
          search glyph. Calm continuous rotation, never a ping/ripple. The 152px
          stage is drawn to spec, then scaled up (the wrapper reserves layout). */}
      <div
        aria-hidden
        style={{
          width: 228,
          height: 228,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "relative",
            width: 152,
            height: 152,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: "scale(1.5)",
          }}
        >
          {/* ambient glow, breathing */}
          <span
            style={{
              position: "absolute",
              inset: 22,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, color-mix(in srgb, var(--accent) 30%, transparent), transparent 68%)",
              animation: "loaderGlowBreathe 4s ease-in-out infinite",
            }}
          />
          {/* outer ring stroke (faint, longer sweep), clockwise */}
          <ArcRing inset={0} sweepDeg={90} dim={55} duration={4.6} />
          {/* inner ring stroke (brighter, shorter sweep), counter-clockwise */}
          <ArcRing inset={16} sweepDeg={65} dim={90} duration={3.4} reverse />
          {/* outer particle orbit (3 dots), clockwise */}
          <div style={{ position: "absolute", inset: 16, animation: "spin 6s linear infinite" }}>
            <OrbitDot angle={0} radius={60} size={7} lead />
            <OrbitDot angle={142} radius={60} size={5} dim={65} />
            <OrbitDot angle={255} radius={60} size={4} dim={45} />
          </div>
          {/* inner particle orbit (2 dots), counter-clockwise */}
          <div
            style={{
              position: "absolute",
              inset: 33,
              animation: "spin 4.2s linear infinite reverse",
            }}
          >
            <OrbitDot angle={60} radius={43} size={4} dim={70} />
            <OrbitDot angle={220} radius={43} size={3} dim={50} />
          </div>
          {/* diamond core, breathing */}
          <span
            style={{
              position: "relative",
              width: 58,
              height: 58,
              borderRadius: 17,
              border: "2px solid var(--accent)",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              display: "grid",
              placeItems: "center",
              animation: "loaderDiamondBreathe 3.6s ease-in-out infinite",
            }}
          >
            {/* search glyph, counter-rotated so it sits upright inside the diamond */}
            <svg
              width="27"
              height="27"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: "rotate(-45deg)" }}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </span>
        </div>
      </div>

      <div
        style={{
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 7,
          position: "relative",
        }}
      >
        <div
          style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", letterSpacing: "-0.01em" }}
        >
          {message}
        </div>
        {/* cycling fun quip (decorative, not announced to screen readers) */}
        <div
          key={quipIdx}
          aria-hidden
          style={{
            fontSize: 12.5,
            color: "var(--fg-3)",
            animation: "fadeIn 0.4s ease-out",
            minHeight: 18,
          }}
        >
          {LOADING_QUIPS[quipIdx]}
        </div>
      </div>
    </div>
  );
}
