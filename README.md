# Mina Editorial AI

## Shopify credits webhook

The Shopify order webhook (`POST /api/credits/shopify-order`) now prefers the
Shopify customer account email over the checkout email when determining which
customer record receives credits. This prevents credits from being applied to a
separate record when a buyer uses a different checkout email.
