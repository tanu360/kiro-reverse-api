import { cancelMicrosoftSso } from "@/lib/api/auth-flows";

/**
 * Server-side login state the dialog must release on every exit path. Flows record their
 * sessions here; `reset()` cancels and clears all of them and bumps `generation`, so a request
 * that started before the reset can tell its response is stale.
 */
export class FlowSessions {
  generation = 0;
  microsoftSessionId = "";
  microsoftSelectionId = "";
  builderIdSession = "";
  builderIdTimer: ReturnType<typeof setTimeout> | null = null;
  iamSession = "";

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  stopBuilderId(): void {
    if (this.builderIdTimer) clearTimeout(this.builderIdTimer);
    this.builderIdTimer = null;
    this.builderIdSession = "";
  }

  /** Fire-and-forget cancel of the Microsoft login, if one is open. */
  cancelMicrosoft(): void {
    const sessionId = this.microsoftSessionId;
    const selectionId = this.microsoftSelectionId;
    this.microsoftSessionId = "";
    this.microsoftSelectionId = "";
    if (sessionId || selectionId) void cancelMicrosoftSso({ sessionId, selectionId });
  }

  /** `cancelMicrosoft: false` after a completed login, whose session the server already closed. */
  reset({ cancelMicrosoft = true }: { cancelMicrosoft?: boolean } = {}): void {
    if (cancelMicrosoft) this.cancelMicrosoft();
    this.microsoftSessionId = "";
    this.microsoftSelectionId = "";
    this.stopBuilderId();
    this.iamSession = "";
    this.generation += 1;
  }
}
