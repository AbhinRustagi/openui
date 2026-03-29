// ─────────────────────────────────────────────────────────────────────────────
// Shared rendering utilities for Renderer and StatefulRenderer
// ─────────────────────────────────────────────────────────────────────────────

import React, { Component } from "react";

// ─── Error boundary ───

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Falls back to the last valid render when a component throws.
 * Resets automatically when children change (e.g. new props from re-evaluation).
 */
export class ElementErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private lastValidChildren: React.ReactNode = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidMount(): void {
    if (!this.state.hasError) {
      this.lastValidChildren = this.props.children;
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (!this.state.hasError) {
      this.lastValidChildren = this.props.children;
    }
    if (this.state.hasError && prevProps.children !== this.props.children) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[openui] Component render error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return this.lastValidChildren;
    }
    return this.props.children;
  }
}

// ─── Loading bar ───

let loadingStyleInjected = false;

export function ensureLoadingStyle() {
  if (loadingStyleInjected || typeof document === "undefined") return;
  loadingStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `@keyframes openui-loading-bar { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`;
  document.head.appendChild(style);
}

export const LoadingBar = () => (
  <div
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: "3px",
      background: "linear-gradient(90deg, transparent 0%, #3b82f6 50%, transparent 100%)",
      backgroundSize: "200% 100%",
      animation: "openui-loading-bar 1.5s ease-in-out infinite",
      zIndex: 10,
    }}
  />
);
