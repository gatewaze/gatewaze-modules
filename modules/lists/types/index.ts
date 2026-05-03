export interface List {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_active: boolean;
  is_public: boolean;
  default_subscribed: boolean;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_events: string[];
  api_key: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  subscriber_count?: number;
}

export interface ListSubscription {
  id: string;
  list_id: string;
  person_id: string | null;
  email: string;
  subscribed: boolean;
  subscribed_at: string | null;
  unsubscribed_at: string | null;
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ListWebhookLog {
  id: string;
  list_id: string;
  event_type: string;
  email: string;
  status: string;
  response_code: number | null;
  response_body: string | null;
  error_message: string | null;
  created_at: string;
}
