/**
 * Raw API shapes for Sage Business Cloud Accounting API v3.1.
 *
 * Wire types exactly as returned by https://api.accounting.sage.com/v3.1.
 * Pure schema definitions; no canonical mapping lives here.
 */

export interface SageListEnvelope<T> {
  $total: number;
  $page: number;
  $itemsPerPage: number;
  $next: string | null;
  $back?: string | null;
  $items: T[];
}

export interface SageResourceRef {
  id: string;
  displayed_as?: string;
  $path?: string;
}

export interface SageBusiness {
  id: string;
  name: string;
  displayed_as?: string;
}

export interface SageLedgerAccount {
  id: string;
  displayed_as?: string;
  name?: string;
  nominal_code?: number | string;
  code?: string;
  ledger_account_type?: {
    id: string;
    displayed_as?: string;
  };
  ledger_account_group?: {
    id: string;
    displayed_as?: string;
  };
  visible_in_banking?: boolean;
  included_in_chart?: boolean;
  updated_at?: string;
  created_at?: string;
}

export interface SageBankAccount {
  id: string;
  displayed_as?: string;
  account_name?: string;
  bank_name?: string;
  ledger_account?: SageResourceRef;
  bank_account_type?: SageResourceRef;
  currency?: SageResourceRef;
  balance?: number;
  opening_balance?: number;
  opening_balance_date?: string;
  inactive?: boolean;
  main_account?: boolean;
  updated_at?: string;
  created_at?: string;
}

export interface SageContact {
  id: string;
  displayed_as?: string;
  name?: string;
  company_name?: string;
  contact_type_ids?: string[];
  contact_types?: SageResourceRef[];
  email?: string;
  main_contact_person?: {
    name?: string;
    email?: string;
    telephone?: string;
  };
  main_address?: {
    address_line_1?: string;
    city?: string;
    postal_code?: string;
    country?: SageResourceRef;
  };
  updated_at?: string;
  created_at?: string;
}

export interface SageInvoiceLine {
  id?: string;
  description?: string;
  ledger_account?: SageResourceRef;
  ledger_account_id?: string;
  quantity?: number;
  unit_price?: number;
  net_amount?: number;
  tax_amount?: number;
  tax_rate?: SageResourceRef;
  total_amount?: number;
}

export interface SageInvoice {
  id: string;
  displayed_as?: string;
  invoice_number?: string;
  contact?: SageResourceRef;
  contact_id?: string;
  date: string; // YYYY-MM-DD
  due_date?: string; // YYYY-MM-DD
  status?: SageResourceRef; // e.g. "PAID", "UNPAID", "PART_PAID", "VOID", "DRAFT"
  void?: boolean;
  currency?: SageResourceRef;
  currency_id?: string;
  total_amount?: number;
  total?: number;
  outstanding_amount?: number;
  net_amount?: number;
  tax_amount?: number;
  invoice_lines?: SageInvoiceLine[];
  updated_at?: string;
  created_at?: string;
}

export interface SageBankTransfer {
  id: string;
  displayed_as?: string;
  date: string;
  amount: number;
  reference?: string;
  description?: string;
  source_bank_account?: SageResourceRef;
  destination_bank_account?: SageResourceRef;
  source_bank_account_id?: string;
  destination_bank_account_id?: string;
  updated_at?: string;
  created_at?: string;
}

export interface SageContactPayment {
  id: string;
  displayed_as?: string;
  date: string;
  total_amount: number;
  transaction_type?: SageResourceRef; // "CUSTOMER_RECEIPT", "VENDOR_PAYMENT"
  bank_account?: SageResourceRef;
  bank_account_id?: string;
  contact?: SageResourceRef;
  contact_id?: string;
  reference?: string;
  payment_method?: SageResourceRef;
  currency?: SageResourceRef;
  allocated_artefacts?: Array<{
    artefact?: SageResourceRef;
    amount?: number;
  }>;
  updated_at?: string;
  created_at?: string;
}

export interface SageOtherPaymentLine {
  ledger_account?: SageResourceRef;
  ledger_account_id?: string;
  total_amount?: number;
  net_amount?: number;
  tax_amount?: number;
  details?: string;
}

export interface SageOtherPayment {
  id: string;
  displayed_as?: string;
  date: string;
  total_amount: number;
  bank_account?: SageResourceRef;
  bank_account_id?: string;
  payment_lines?: SageOtherPaymentLine[];
  reference?: string;
  payment_method?: SageResourceRef;
  currency?: SageResourceRef;
  contact?: SageResourceRef;
  contact_id?: string;
  updated_at?: string;
  created_at?: string;
}

export interface SageOtherReceiptLine {
  ledger_account?: SageResourceRef;
  ledger_account_id?: string;
  total_amount?: number;
  net_amount?: number;
  tax_amount?: number;
  details?: string;
}

export interface SageOtherReceipt {
  id: string;
  displayed_as?: string;
  date: string;
  total_amount: number;
  bank_account?: SageResourceRef;
  bank_account_id?: string;
  receipt_lines?: SageOtherReceiptLine[];
  reference?: string;
  payment_method?: SageResourceRef;
  currency?: SageResourceRef;
  contact?: SageResourceRef;
  contact_id?: string;
  updated_at?: string;
  created_at?: string;
}

export interface SageRawBankTransaction {
  id: string;
  displayed_as?: string;
  bank_account?: SageResourceRef;
  bank_account_id?: string;
  date: string;
  amount: number;
  currency?: SageResourceRef;
  currency_id?: string;
  description?: string;
  reference?: string;
  ledger_account?: SageResourceRef;
  ledger_account_id?: string;
  contact?: SageResourceRef;
  contact_id?: string;
  updated_at?: string;
  created_at?: string;
}
