import { createHmac, timingSafeEqual } from "node:crypto";
import type { FoundryBillingPlanId } from "@sandbox-agent/foundry-shared";

export class StripeAppError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "StripeAppError";
    this.status = status;
  }
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface StripePortalSession {
  url: string;
}

export interface StripeSubscriptionSnapshot {
  id: string;
  customerId: string;
  priceId: string | null;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  defaultPaymentMethodLabel: string;
}

export interface StripeCheckoutCompletion {
  customerId: string | null;
  subscriptionId: string | null;
  planId: FoundryBillingPlanId | null;
  paymentMethodLabel: string;
}

export interface StripeWebhookEvent<T = unknown> {
  id: string;
  type: string;
  data: {
    object: T;
  };
}

export interface StripeAppClientOptions {
  apiBaseUrl?: string;
  secretKey?: string;
  webhookSecret?: string;
  teamPriceId?: string;
}

export class StripeAppClient {
  private readonly apiBaseUrl: string;
  private readonly secretKey?: string;
  private readonly webhookSecret?: string;
  private readonly teamPriceId?: string;

  constructor(options: StripeAppClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
    this.secretKey = options.secretKey ?? process.env.STRIPE_SECRET_KEY;
    this.webhookSecret = options.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    this.teamPriceId = options.teamPriceId ?? process.env.STRIPE_PRICE_TEAM;
  }

  isConfigured(): boolean {
    return Boolean(this.secretKey);
  }

  createCheckoutSession(input: {
    organizationId: string;
    customerId: string;
    customerEmail: string | null;
    planId: Exclude<FoundryBillingPlanId, "free">;
    successUrl: string;
    cancelUrl: string;
  }): Promise<StripeCheckoutSession> {
    const priceId = this.priceIdForPlan(input.planId);
    return this.formRequest<StripeCheckoutSession>("/v1/checkout/sessions", {
      mode: "subscription",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      customer: input.customerId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "metadata[organizationId]": input.organizationId,
      "metadata[planId]": input.planId,
      "subscription_data[metadata][organizationId]": input.organizationId,
      "subscription_data[metadata][planId]": input.planId,
    });
  }

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<StripePortalSession> {
    return this.formRequest<StripePortalSession>("/v1/billing_portal/sessions", {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
  }

  createCustomer(input: { organizationId: string; displayName: string; email: string | null }): Promise<{ id: string }> {
    return this.formRequest<{ id: string }>("/v1/customers", {
      name: input.displayName,
      ...(input.email ? { email: input.email } : {}),
      "metadata[organizationId]": input.organizationId,
    });
  }

  async updateSubscriptionCancellation(subscriptionId: string, cancelAtPeriodEnd: boolean): Promise<StripeSubscriptionSnapshot> {
    const payload = await this.formRequest<Record<string, unknown>>(`/v1/subscriptions/${subscriptionId}`, {
      cancel_at_period_end: cancelAtPeriodEnd ? "true" : "false",
    });
    return stripeSubscriptionSnapshot(payload);
  }

  async retrieveCheckoutCompletion(sessionId: string): Promise<StripeCheckoutCompletion> {
    const payload = await this.requestJson<Record<string, unknown>>(`/v1/checkout/sessions/${sessionId}?expand[]=subscription.default_payment_method`);

    const subscription = typeof payload.subscription === "object" && payload.subscription ? (payload.subscription as Record<string, unknown>) : null;
    const subscriptionId =
      typeof payload.subscription === "string" ? payload.subscription : subscription && typeof subscription.id === "string" ? subscription.id : null;
    const priceId = firstStripePriceId(subscription);

    return {
      customerId: typeof payload.customer === "string" ? payload.customer : null,
      subscriptionId,
      planId: priceId ? this.planIdForPriceId(priceId) : planIdFromMetadata(payload.metadata),
      paymentMethodLabel: subscription ? paymentMethodLabelFromObject(subscription.default_payment_method) : "Card on file",
    };
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot> {
    const payload = await this.requestJson<Record<string, unknown>>(`/v1/subscriptions/${subscriptionId}?expand[]=default_payment_method`);
    return stripeSubscriptionSnapshot(payload);
  }

  verifyWebhookEvent(payload: string, signatureHeader: string | null): StripeWebhookEvent {
    if (!this.webhookSecret) {
      throw new StripeAppError("Stripe webhook secret is not configured", 500);
    }
    if (!signatureHeader) {
      throw new StripeAppError("Missing Stripe signature header", 400);
    }

    const parts = Object.fromEntries(
      signatureHeader
        .split(",")
        .map((entry) => entry.split("="))
        .filter((entry): entry is [string, string] => entry.length === 2),
    );
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) {
      throw new StripeAppError("Malformed Stripe signature header", 400);
    }

    const expected = createHmac("sha256", this.webhookSecret).update(`${timestamp}.${payload}`).digest("hex");

    const expectedBuffer = Buffer.from(expected, "utf8");
    const actualBuffer = Buffer.from(signature, "utf8");
    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new StripeAppError("Stripe signature verification failed", 400);
    }

    return JSON.parse(payload) as StripeWebhookEvent;
  }

  planIdForPriceId(priceId: string): FoundryBillingPlanId | null {
    if (priceId === this.teamPriceId) {
      return "team";
    }
    return null;
  }

  priceIdForPlan(planId: Exclude<FoundryBillingPlanId, "free">): string {
    const priceId = this.teamPriceId;
    if (!priceId) {
      throw new StripeAppError(`Stripe price ID is not configured for ${planId}`, 500);
    }
    return priceId;
  }

  private async requestJson<T>(path: string): Promise<T> {
    if (!this.secretKey) {
      throw new StripeAppError("Stripe is not configured", 500);
    }

    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    const payload = (await response.json()) as T | { error?: { message?: string } };
    if (!response.ok) {
      throw new StripeAppError(
        typeof payload === "object" && payload && "error" in payload ? (payload.error?.message ?? "Stripe request failed") : "Stripe request failed",
        response.status,
      );
    }
    return payload as T;
  }

  private async formRequest<T>(path: string, body: Record<string, string>): Promise<T> {
    if (!this.secretKey) {
      throw new StripeAppError("Stripe is not configured", 500);
    }

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      form.set(key, value);
    }

    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    const payload = (await response.json()) as T | { error?: { message?: string } };
    if (!response.ok) {
      throw new StripeAppError(
        typeof payload === "object" && payload && "error" in payload ? (payload.error?.message ?? "Stripe request failed") : "Stripe request failed",
        response.status,
      );
    }
    return payload as T;
  }
}

function planIdFromMetadata(metadata: unknown): FoundryBillingPlanId | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const planId = (metadata as Record<string, unknown>).planId;
  return planId === "team" || planId === "free" ? planId : null;
}

function firstStripePriceId(subscription: Record<string, unknown> | null): string | null {
  if (!subscription || typeof subscription.items !== "object" || !subscription.items) {
    return null;
  }
  const data = (subscription.items as { data?: Array<Record<string, unknown>> }).data;
  const first = data?.[0];
  if (!first || typeof first.price !== "object" || !first.price) {
    return null;
  }
  return typeof (first.price as Record<string, unknown>).id === "string" ? ((first.price as Record<string, unknown>).id as string) : null;
}

function paymentMethodLabelFromObject(paymentMethod: unknown): string {
  if (!paymentMethod || typeof paymentMethod !== "object") {
    return "Card on file";
  }
  const card = (paymentMethod as Record<string, unknown>).card;
  if (card && typeof card === "object") {
    const brand = typeof (card as Record<string, unknown>).brand === "string" ? ((card as Record<string, unknown>).brand as string) : "Card";
    const last4 = typeof (card as Record<string, unknown>).last4 === "string" ? ((card as Record<string, unknown>).last4 as string) : "file";
    return `${capitalize(brand)} ending in ${last4}`;
  }
  return "Payment method on file";
}

function stripeSubscriptionSnapshot(payload: Record<string, unknown>): StripeSubscriptionSnapshot {
  return {
    id: typeof payload.id === "string" ? payload.id : "",
    customerId: typeof payload.customer === "string" ? payload.customer : "",
    priceId: firstStripePriceId(payload),
    status: typeof payload.status === "string" ? payload.status : "active",
    cancelAtPeriodEnd: payload.cancel_at_period_end === true,
    currentPeriodEnd: typeof payload.current_period_end === "number" ? payload.current_period_end : null,
    trialEnd: typeof payload.trial_end === "number" ? payload.trial_end : null,
    defaultPaymentMethodLabel: paymentMethodLabelFromObject(payload.default_payment_method),
  };
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
