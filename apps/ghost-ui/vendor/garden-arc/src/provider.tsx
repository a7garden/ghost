/// <reference path="css.d.ts" />
"use client";
import { createContext, useContext, useState, type ComponentType, type HTMLAttributes, type ReactNode } from "react";
import { MotionConfig, useReducedMotion } from "motion/react";

const PortalContext = createContext<HTMLElement | null>(null);
const MotionContext = createContext<"user" | "reduce">("user");

export interface ArcProviderProps extends HTMLAttributes<HTMLDivElement> {
  /** Explicit theme follows host state; it never writes documentElement or storage. */
  theme: "light" | "dark";
  accent?: "neutral" | "violet" | "blue" | "green" | "amber" | "orange" | "coral" | "rose";
  tokens?: "arc" | "garden";
  density?: "comfortable" | "compact";
  motion?: "user" | "reduce";
}

/** Mount styles once. Each boundary supplies independent tokens and overlay ownership. */
export function ArcProvider({ theme, accent = "neutral", tokens = "arc", density = "comfortable", motion = "user", className, children, ...props }: ArcProviderProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return <MotionContext.Provider value={motion}>
    <MotionConfig reducedMotion={motion === "reduce" ? "always" : "user"}>
      <div {...props} className={["garden-arc", className].filter(Boolean).join(" ")} data-theme={theme} data-accent={accent} data-tokens={tokens} data-density={density} data-motion={motion}>
        <PortalContext.Provider value={container}>{children}</PortalContext.Provider>
        <div ref={setContainer} data-arc-portals="" />
      </div>
    </MotionConfig>
  </MotionContext.Provider>;
}

export function useArcPortalContainer() { return useContext(PortalContext); }
export function useArcReducedMotion() {
  const preference = useReducedMotion();
  const override = useContext(MotionContext);
  return override === "reduce" || preference;
}

type PortalComponent = ComponentType<{ children?: ReactNode; container?: HTMLElement | null; forceMount?: true }>;
/** No fallback body portal: avoids unthemed overlays before the boundary mounts. */
export function ArcPortal({ portal: Portal, container: requestedContainer, ...props }: { portal: PortalComponent; children?: ReactNode; forceMount?: true; container?: HTMLElement | null }) {
  const container = useArcPortalContainer();
  return container ? <Portal {...props} container={requestedContainer ?? container} /> : null;
}
