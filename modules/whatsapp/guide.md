# WhatsApp Messaging

Send WhatsApp messages via the Twilio WhatsApp Business API for event invites, notifications, and reminders. Supports both freeform messages and pre-approved WhatsApp message templates with rich formatting.

## How It Works

When this module is enabled, WhatsApp becomes available as a delivery channel for other modules. The event-invites module can send invite links via WhatsApp instead of email, delivering them directly to the recipient's WhatsApp inbox.

The module uses Twilio's WhatsApp channel, which routes messages through the same Twilio infrastructure as SMS but with WhatsApp-specific features like read receipts, rich media, and message templates. All sent messages are tracked in the `whatsapp_send_log` table with Twilio SID, delivery status (including read receipts), and metadata.

Phone numbers must be in E.164 format (e.g., `+447700900000` or `+14155552671`).

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | string | Yes | Your Twilio Account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | string | Yes | Your Twilio Auth Token |
| `WHATSAPP_FROM_NUMBER` | string | Yes | Twilio WhatsApp sender number in E.164 format |

Configure these in the module settings page after enabling the module. You can use the **Test Send** button to verify your credentials are working.

### Getting Started with Twilio WhatsApp

1. Sign up at [twilio.com](https://www.twilio.com) (you can reuse existing credentials if you already have the Twilio SMS module)
2. From the Twilio Console, navigate to **Messaging > Try it out > Send a WhatsApp message** to set up the WhatsApp Sandbox for testing
3. The sandbox number is typically `+14155238886` -- use this as your **WhatsApp From Number** during development
4. For production, apply for a dedicated WhatsApp Business number through Twilio

### WhatsApp Sandbox (Testing)

During development, recipients must first opt in to your sandbox by sending a specific message (e.g., "join <sandbox-keyword>") to the sandbox number. This is a Twilio/WhatsApp requirement for sandbox environments and is not needed in production.

### Message Templates (Production)

In production, the first message to a new recipient must use a pre-approved WhatsApp message template. The module supports template-based sending via the `template_name` and `template_variables` fields. Templates are managed through the Twilio Console.

## Features

- `whatsapp` -- Core WhatsApp messaging functionality and configuration
- `whatsapp.send` -- Send WhatsApp messages via the Twilio API

## Dependencies

None. This module operates independently and is discovered at runtime by modules that support WhatsApp delivery (e.g., event-invites).
