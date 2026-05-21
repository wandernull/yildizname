// PaymentProvider — abstract surface so the real provider (Stripe Checkout
// + webhook, planned by the user) can drop in without touching the API
// route or the frontend. The mock always succeeds with a synthetic
// transaction id.

export interface PaymentResult {
  success: boolean;
  transactionId: string;
  message?: string;
}

export interface ChargeArgs {
  readingId: string;
  amount: number; // minor units (kuruş) once a real provider is wired
  currency: string; // ISO 4217, e.g. "TRY"
}

export interface PaymentProvider {
  charge(args: ChargeArgs): Promise<PaymentResult>;
}

export class MockPaymentProvider implements PaymentProvider {
  async charge(args: ChargeArgs): Promise<PaymentResult> {
    return {
      success: true,
      transactionId: `mock_${args.readingId}_${Date.now()}`,
    };
  }
}

// TODO: implement StripePaymentProvider that creates a Checkout Session
// and verifies the webhook signature in src/routes/stripe-webhook.ts.

export function defaultPaymentProvider(): PaymentProvider {
  return new MockPaymentProvider();
}
