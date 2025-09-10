# Shopify Loyalty (Single-Function PoC)

## 0) Prereqs
- Supabase project
- In Shopify Admin → **Apps → Develop apps → Create app**
  - Scopes: `read_orders`, `write_discounts`
  - Reveal **Admin API access token** and **API secret**
  - In **Settings → Notifications → Webhooks**:
    - Add webhooks for `orders/create`, `orders/updated`, `refunds/create`
    - URL: `https://<edge-url>/app/webhooks` (see deploy below)

## 1) Migrate
```bash
supabase db push
# or:
# supabase migration up
