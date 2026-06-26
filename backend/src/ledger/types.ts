export type BmsAccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type BmsOwnerType = "user" | "account";
export type BmsEntryType = "DEBIT" | "CREDIT";
export type BmsHoldStatus = "ACTIVE" | "CAPTURED" | "RELEASED" | "EXPIRED";

export interface BmsAccount {
  id: string;
  tenant_id: number;
  owner_type: BmsOwnerType;
  owner_id: number;
  account_type: BmsAccountType;
  currency_code: string;
  ledger_balance: number;
  held_balance: number;
  available_balance: number;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface DoubleEntryInput {
  tenantId: number;
  idempotencyKey: string;
  description?: string;
  entries: Array<{
    accountId: string;
    amount: number;
    type: BmsEntryType;
  }>;
}

export interface JournalEntryResult {
  journalEntryId: string;
  ledgerEntryIds: string[];
}
