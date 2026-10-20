export interface ProjectRecord { id: string; name: string; description: string | null; ownerId: string | null; kind: "user" | "public_demo"; networkId: string; createdAt: string }
export interface ContractRecord { id: string; projectId: string; address: string; name: string | null; runtimeType: string; abi: unknown[] | null; startBlock: number | null; deploymentTxHash: string | null; status: string; createdAt: string }
export interface ApiKeyRecord { id: string; projectId: string; name: string; scope: "read" | "write"; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export type ReceiverMode = "ok" | "fail500" | "fail400" | "timeout";
export interface ReceiverRecord { id: string; endpointId: string; mode: ReceiverMode; createdAt: string }
export interface ReceiverRequestRecord { id: number; receivedAt: string; eventId: string | null; deliveryId: string | null; attempt: number | null; signatureOk: boolean; signatureReason: string | null; outcome: string; httpStatus: number; bodyPreview: string | null }
export interface AutomationRecord { id: string; projectId: string; name: string; triggerEventName: string | null; triggerContract: string | null; endpointId: string; enabled: boolean; createdAt: string }

// Ordered rules; each replacement keeps the label (group 1) and drops the secret value.
const REDACT: [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^"',\s}]+/gi, "$1[redacted]"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [/\bwhsec_[A-Za-z0-9_-]+/g, "[redacted]"],
  [/\bpops_[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/((?:secret|password|passwd|token|api[_-]?key|private[_-]?key|seed[_-]?phrase|mnemonic)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[redacted]"],
];
/** Never let credentials into the log table (PRD §8.11). Transaction and block hashes are deliberately left intact. */
export function redact(text: string): string {
  return REDACT.reduce((out, [re, to]) => out.replace(re, to), text);
}
