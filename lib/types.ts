// Shared domain types for the PayQR frontend.

export interface Country {
  id: string;
  flag: string;
  name: string;
  code: string;          // ISO-4217-style currency code, e.g. "INR"
  symbol: string;
  fiat: string;          // payout rail label, e.g. "UPI"
  payoutLabel: string;
  payoutPlaceholder: string;
  validatePayout: (v: string) => boolean;
  locale: string;
}

export interface Language {
  code: string;
  label: string;
}
