# Custom Domains Module

Assign custom domains to your events, blog posts, newsletters, and other content to create white-label websites with automatic HTTPS.

## How It Works

1. **Register a domain** in the Custom Domains admin page
2. **Configure DNS** — point your domain to the platform using a CNAME or A record
3. **Wait for verification** — the system automatically checks your DNS configuration
4. **TLS certificate** is provisioned automatically via Let's Encrypt
5. **Assign to content** — map the domain to an event, blog, or other content item
6. Visitors see your content at your custom domain with full branding

## A module at the root of its own domain

A domain can carry a whole module rather than one piece of content: assign it a content type that is a module id with portal pages (for example `photo-booth`) and no item. The portal then serves that module at the domain root (`example.com/b/x` is the module's `/photo-booth/b/x`), with no portal header or footer at all; the module owns the page. Sign-in, the legal pages and `/api` still pass through. Needs portal 1.3.191 or later.

## The look

Each domain may have its own look, set in **Look** on the domain's page and stored in `custom_domains.theme`. It is a small set of design tokens, never raw CSS: light or dark, seven colours (background, surface, text, muted, primary, text on primary, border), a heading and a body font (Google Fonts family names), an https logo, and the corner radius. The api checks every value on save and the portal checks them again on read; a field that fails is named in the error and nothing is kept.

On a page served by the domain the tokens arrive as CSS variables on `<html>`: `--cd-bg`, `--cd-surface`, `--cd-text`, `--cd-muted`, `--cd-primary`, `--cd-primary-text`, `--cd-border`, `--cd-font-heading`, `--cd-font-body`, `--cd-radius` and `--cd-logo` (a `url(...)`), with `data-custom-domain-mode` set to `light` or `dark`. The portal's own `--primary-color`, `--font-display` and `--font-sans` follow the primary colour and fonts, so the shared sign-in and legal pages match. A background colour also replaces the brand's animated background with a flat one. Changes reach visitors within five minutes (the middleware caches the row).

A design produced elsewhere (for example in Claude Design) is implemented by reading its tokens into these fields, and its sections into the module's own pages.

## Who can change domains

Every route under `/api/modules/custom-domains` except the lookups (`GET /lookup/:contentType/:contentId`, `POST /lookup-batch`, which other modules' admin panels use to show a domain for a piece of content) requires a verified session belonging to an active admin or super admin. The platform does not gate module routes itself; this module does.

## Getting Started

### 1. Register a Domain

Go to **Admin → Custom Domains** and click **Add Domain**. Enter your bare domain name (e.g., `myconference.com` or `events.mycompany.com`).

### 2. Configure DNS

After registering, you'll see DNS setup instructions:

**For subdomains** (e.g., `events.mycompany.com`):
- Add a **CNAME** record pointing to the provided target hostname

**For root/apex domains** (e.g., `myconference.com`):
- Add an **A** record pointing to the provided IP address
- Or use an **ALIAS/ANAME** record if your DNS provider supports it (Cloudflare, AWS Route53, DNSimple)

> **Note:** Root domains cannot use CNAME records (DNS specification limitation). If the platform's IP address changes, you'll need to update your A record. Subdomains with CNAME records follow automatically.

### 3. Verify DNS

The system checks DNS automatically every 60 seconds. You can also click **Verify DNS** to check immediately. Once verified, the status changes to "DNS Verified."

### 4. Certificate Provisioning

After DNS verification, a TLS certificate is automatically requested from Let's Encrypt. This typically takes 1–5 minutes. The status shows "Provisioning" during this time.

### 5. Assign to Content

Once the domain is **Active**, assign it to a content item:

- From the Custom Domains page, click a domain and use the **Assign** button
- Or from an event's settings page, use the **Custom Domain** selector

You can also assign from any content item's settings that supports the Domain Selector component.

## Status Reference

| Status | Meaning |
|--------|---------|
| **Pending** | Domain registered, waiting for DNS verification |
| **DNS Verified** | DNS is correct, certificate being requested |
| **Provisioning** | Let's Encrypt is issuing the TLS certificate |
| **Active** | Domain is live and serving traffic with HTTPS |
| **Error** | Something went wrong — check the error message |
| **Removing** | Domain is being decommissioned |

## Branding

You can optionally set per-domain branding:
- **Page Title** — custom HTML `<title>` for the domain
- **Favicon URL** — custom favicon

## Requirements

This module requires a Kubernetes cluster with:
- **NGINX Ingress Controller** — routes traffic to the portal
- **cert-manager** with a configured ClusterIssuer — provisions TLS certificates
- **Custom Domain Controller** deployment — manages the domain lifecycle

The controller is configured via Helm values:
```yaml
customDomains:
  enabled: true
  cnameTarget: "custom.yourdomain.com"
  expectedIp: "your.cluster.ip"
  clusterIssuer: "letsencrypt-prod"
```

## FAQ

**Can I use a root domain like `myconference.com`?**
Yes! Use an A record pointing to the platform's IP address instead of a CNAME.

**How long does it take to go live?**
DNS propagation: minutes to hours. Certificate: 1–5 minutes after DNS verification. Total: usually under 30 minutes.

**Can I assign one domain to multiple content items?**
Not in v1. Each domain maps to exactly one content item.

**What happens if I delete the content item?**
The domain becomes unassigned but stays registered. You can reassign it to different content.

**Can I transfer a domain to a different event?**
Yes — unassign from the current content, then assign to the new one.
