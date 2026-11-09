import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, getAuthConfig, getCurrentUser, logoutCurrentUser, setAuthEnabled as setApiAuthEnabled, setAuthToken, setUnauthorizedHandler } from "./api";
import type { AuthenticatedUser } from "./types";

const TOKEN_KEY = "ai-harness.google-id-token";

type CredentialResponse = { credential: string };
type GoogleIdentity = {
  initialize: (options: { client_id: string; callback: (response: CredentialResponse) => void; auto_select?: boolean; cancel_on_tap_outside?: boolean; use_fedcm_for_prompt?: boolean; button_auto_select?: boolean }) => void;
  renderButton: (element: HTMLElement, options: Record<string, string | number | boolean>) => void;
  prompt: () => void;
  cancel: () => void;
  disableAutoSelect: () => void;
};

declare global {
  interface Window { google?: { accounts: { id: GoogleIdentity } }; }
}

type AuthContextValue = { user: AuthenticatedUser; authEnabled: boolean; signingOut: boolean; signOut: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | null>(null);
let googleScriptPromise: Promise<void> | null = null;

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts.id) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Could not load Google sign-in")), { once: true });
    if (!existing) {
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  return googleScriptPromise;
}

function LoginScreen({ clientId, error, signingIn, onCredential }: { clientId: string; error: string; signingIn: boolean; onCredential: (token: string) => Promise<void> }) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [googleError, setGoogleError] = useState("");

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    loadGoogleIdentity().then(() => {
      if (!active || !buttonRef.current || !window.google) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (response) => void onCredential(response.credential), auto_select: true, button_auto_select: true, cancel_on_tap_outside: false, use_fedcm_for_prompt: true });
      buttonRef.current.replaceChildren();
      window.google.accounts.id.renderButton(buttonRef.current, { type: "standard", theme: "outline", size: "large", text: "continue_with", shape: "rectangular", width: 320 });
      window.google.accounts.id.prompt();
    }).catch((reason: Error) => { if (active) setGoogleError(reason.message); });
    return () => { active = false; window.google?.accounts.id.cancel(); };
  }, [clientId, onCredential]);

  return <main className="auth-page"><section className="auth-card" aria-labelledby="auth-title">
    <div className="auth-brand" aria-hidden="true">AI</div>
    <p className="eyebrow">AI GOVERNANCE PLATFORM</p>
    <h1 id="auth-title">Welcome to AI Harness</h1>
    <p>Sign in or register with your Google account to manage agents, tools, initiatives, and analytics.</p>
    {clientId && <div className="auth-signin-control">
      <div className={`google-signin-button${signingIn ? " pending" : ""}`} ref={buttonRef} aria-hidden={signingIn} />
      {signingIn && <div className="auth-signin-bubbles" role="status" aria-label="Signing you in">
        <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
      </div>}
    </div>}
    {(error || googleError) && <div className="auth-error" role="alert">{error || googleError}</div>}
    {!clientId && !error && <div className="auth-loading"><i className="loading-circle" /> Loading authentication…</div>}
    <small>Your Google ID token is validated by the server and retained only for this browser tab.</small>
  </section></main>;
}

function AccessDeniedScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="auth-page"><section className="auth-card access-denied-card" aria-labelledby="access-denied-title">
    <div className="auth-brand" aria-hidden="true">AI</div>
    <p className="eyebrow">ACCESS REQUIRED</p>
    <h1 id="access-denied-title">Access denied</h1>
    <div className="auth-error" role="alert">{message}</div>
    <p>Ask an administrator to re-enable this email, or continue with another Google account.</p>
    <button type="button" className="primary-button" onClick={onRetry}>Use another Google account</button>
  </section></main>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [clientId, setClientId] = useState("");
  const [authEnabled, setAuthEnabled] = useState(true);
  const [error, setError] = useState("");
  const [accessDenied, setAccessDenied] = useState("");
  const [bootstrapping, setBootstrapping] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signInPendingRef = useRef(false);

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    setUser(null);
  }, []);
  const signOut = useCallback(async () => {
    if (!authEnabled || signingOut) return;
    setSigningOut(true);
    try {
      await logoutCurrentUser();
    } catch {
      // Local logout must still succeed when the audit endpoint is unavailable.
    } finally {
      clearSession();
      window.google?.accounts.id.disableAutoSelect();
      setSigningOut(false);
    }
  }, [authEnabled, clearSession, signingOut]);

  useEffect(() => {
    setUnauthorizedHandler((accessDeniedMessage) => {
      clearSession();
      if (accessDeniedMessage) setAccessDenied(accessDeniedMessage);
    });
    let active = true;
    void (async () => {
      try {
        const config = await getAuthConfig();
        if (!active) return;
        setApiAuthEnabled(config.auth_enabled);
        setAuthEnabled(config.auth_enabled);
        if (!config.auth_enabled) {
          setAuthToken(null);
          const currentUser = await getCurrentUser();
          if (active) setUser(currentUser);
          return;
        }
        if (!config.client_id) throw new Error("Google authentication is not configured");
        setClientId(config.client_id);
        const savedToken = sessionStorage.getItem(TOKEN_KEY);
        if (savedToken) {
          setAuthToken(savedToken);
          try { const currentUser = await getCurrentUser(); if (active) setUser(currentUser); }
          catch (reason) {
            clearSession();
            if (reason instanceof ApiError && reason.status === 403) setAccessDenied(reason.message);
          }
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Authentication is unavailable");
      } finally { if (active) setBootstrapping(false); }
    })();
    return () => { active = false; setUnauthorizedHandler(null); };
  }, [clearSession]);

  const acceptCredential = useCallback(async (token: string) => {
    if (signInPendingRef.current) return;
    signInPendingRef.current = true;
    setSigningIn(true);
    setError("");
    setAuthToken(token);
    try {
      const currentUser = await getCurrentUser();
      sessionStorage.setItem(TOKEN_KEY, token);
      setUser(currentUser);
    } catch (reason) {
      clearSession();
      if (reason instanceof ApiError && reason.status === 403) setAccessDenied(reason.message);
      else setError(reason instanceof Error ? reason.message : "Google sign-in failed");
    } finally {
      signInPendingRef.current = false;
      setSigningIn(false);
    }
  }, [clearSession]);

  const retryWithAnotherAccount = useCallback(() => {
    clearSession();
    window.google?.accounts.id.disableAutoSelect();
    setAccessDenied("");
    setError("");
  }, [clearSession]);

  if (bootstrapping) return <main className="auth-page"><div className="auth-loading"><i className="loading-circle" /> Restoring your session…</div></main>;
  if (accessDenied) return <AccessDeniedScreen message={accessDenied} onRetry={retryWithAnotherAccount} />;
  if (!user) return <LoginScreen clientId={clientId} error={error} signingIn={signingIn} onCredential={acceptCredential} />;
  return <AuthContext.Provider value={{ user, authEnabled, signingOut, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
