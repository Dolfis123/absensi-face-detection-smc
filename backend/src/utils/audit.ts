import { randomBytes } from 'crypto';

/**
 * Token rahasia per-proses. Hook model Attendance menolak UPDATE/DELETE kecuali
 * options-nya membawa token ini, dan token hanya dipakai oleh services/correctionService.ts.
 */
export const AUDIT_TOKEN = randomBytes(24).toString('hex');

export interface AuditOptions {
  auditToken?: string;
}
