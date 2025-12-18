# Error Logging Emoji Legend

| Emoji | Meaning | Example Code |
| --- | --- | --- |
| 🔥 | Backend 5xx / server crash in request handling (API error) | `🔥 API_ERROR` |
| 🖥️ | Frontend crash reported to backend (`/api/log-error`) | `🖥️ FRONTEND_CRASH` |
| 🚫 | Auth/permission issue (401/403) | `🚫 AUTH_ERROR` |
| ⚠️ | Validation / 4xx / handled error (non-5xx) | `⚠️ VALIDATION_ERROR` |
| ⏱️ | Timeout (408/504 or known timeout) | `⏱️ TIMEOUT` |
| 🛰️ | External provider error (OpenAI/Stripe/Shopify/network) | `🛰️ PROVIDER_ERROR` |
| 🧵 | Unhandled promise rejection (process-level) | `🧵 UNHANDLED_REJECTION` |
| 💥 | Uncaught exception (process-level) | `💥 UNCAUGHT_EXCEPTION` |

## How to filter in Supabase

```sql
select mg_event_at, mg_error_code, mg_error_message
from mega_admin
where mg_record_type='error'
order by mg_event_at desc;
```
