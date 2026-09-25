/** Holds the short-lived MFA challenge between the sign-in and verification screens (kept in memory, never in a URL or on disk). */
let challenge: string | null = null;
export const setPendingMfa = (token: string | null) => {
  challenge = token;
};
export const getPendingMfa = () => challenge;
