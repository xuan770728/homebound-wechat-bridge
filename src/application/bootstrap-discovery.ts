import crypto from "node:crypto";

type Candidate = { fromUserId: string; contextToken: string; observedAt: string };
type Session = { id: string; expiresAt: number; candidates: Map<string, Candidate> };

const SESSION_TTL_MS = 10 * 60_000;

export class BootstrapDiscovery {
  private readonly sessions = new Map<string, Session>();

  start(): { sessionId: string; expiresAt: string } {
    this.cleanup();
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(id, { id, expiresAt, candidates: new Map() });
    return { sessionId: id, expiresAt: new Date(expiresAt).toISOString() };
  }

  observeInbound(fromUserId: string, contextToken: string): void {
    if (!fromUserId || !contextToken) return;
    this.cleanup();
    const observedAt = new Date().toISOString();
    for (const session of this.sessions.values()) {
      session.candidates.set(fromUserId, { fromUserId, contextToken, observedAt });
    }
  }

  list(sessionId: string): Array<{ fromUserId: string; observedAt: string }> {
    const session = this.get(sessionId);
    return [...session.candidates.values()].map(({ fromUserId, observedAt }) => ({ fromUserId, observedAt }));
  }

  candidate(sessionId: string, fromUserId: string): Candidate {
    const session = this.get(sessionId);
    const candidate = session.candidates.get(fromUserId);
    if (!candidate) throw new Error("BOOTSTRAP_CANDIDATE_NOT_FOUND");
    return candidate;
  }

  complete(sessionId: string, fromUserId: string): void {
    const session = this.get(sessionId);
    if (!session.candidates.has(fromUserId)) throw new Error("BOOTSTRAP_CANDIDATE_NOT_FOUND");
    this.sessions.delete(sessionId);
  }

  private get(sessionId: string): Session {
    this.cleanup();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("BOOTSTRAP_SESSION_NOT_FOUND");
    return session;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }
}
