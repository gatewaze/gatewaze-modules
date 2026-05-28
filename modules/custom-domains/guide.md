# Custom Domains Module

Assign custom domains to your events, blog posts, newsletters, and other content to create white-label websites with automatic HTTPS.

## How It Works

1. **Register a domain** in the Custom Domains admin page
2. **Configure DNS** — point your domain to the platform using a CNAME or A record
3. **Wait for verification** — the system automatically checks your DNS configuration
4. **TLS certificate** is provisioned automatically via Let's Encrypt
5. **Assign to content** — map the domain to an event, blog, or other content item
6. Visitors see your content at your custom domain with full branding

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
